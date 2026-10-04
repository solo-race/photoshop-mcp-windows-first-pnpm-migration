import { platform } from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { toExtendScriptValue } from '../core/serializer.js';

export interface ScriptScope {
  documentId?: number;
  documentPath?: string;
  layerId?: number;
  recheck: () => Promise<void>;
}

import { Logger } from '../utils/logger.js';
import { PhotoshopDetector } from './detector.js';
import { ScriptExecutor } from './script-executor.js';
import { WindowsExecutor, ScriptExecutionError } from './windows-executor.js';
import { OperationLock, operationContext } from '../core/operation-lock.js';
import { MacOSExecutor } from './macos-executor.js';
import type { DiagnosticsInfo, ExecutionMode } from '../core/models.js';

export interface PhotoshopInfo {
  version: string;
  path: string;
  isRunning: boolean;
  detectedYear?: string;
  appName?: string;
}

export class PhotoshopConnection {
  private scope = new AsyncLocalStorage<ScriptScope>();
  private faulted = false;
  private directLock = new OperationLock();
  private directQueue: Promise<unknown> = Promise.resolve();
  private epoch = randomUUID();
  private epochInstalled = false;
  private logger: Logger;
  private detector: PhotoshopDetector;
  private executor: ScriptExecutor;
  private photoshopInfo: PhotoshopInfo | null = null;
  private macosExecutor?: MacOSExecutor;

  get isFaulted(): boolean {
    return this.faulted;
  }

  constructor() {
    this.logger = new Logger('PhotoshopConnection');
    this.detector = new PhotoshopDetector();

    // Initialize platform-specific executor
    const platformType = platform();
    if (platformType === 'win32') {
      this.executor = new WindowsExecutor();
    } else if (platformType === 'darwin') {
      this.macosExecutor = new MacOSExecutor();
      this.executor = this.macosExecutor;
    } else {
      // Offline policy/registry tests and stdio capability inspection are possible on Linux.
      this.executor = {
        execute: async () => {
          throw new Error('Photoshop execution requires Windows or macOS');
        },
        isPhotoshopRunning: async () => false,
        launchPhotoshop: async () => {
          throw new Error('Automatic launch disabled');
        },
      };
    }
  }

  async detect(): Promise<PhotoshopInfo> {
    this.photoshopInfo = await this.detector.detect();
    return this.photoshopInfo;
  }

  async ping(): Promise<boolean> {
    try {
      const info = await this.getVersionInfo();
      return info.canExecuteScript;
    } catch (error) {
      this.logger.error('Ping failed:', error);
      return false;
    }
  }

  async getVersion(): Promise<string> {
    try {
      const info = await this.getVersionInfo();
      return info.version || 'Unknown';
    } catch (error) {
      this.logger.error('Failed to get version:', error);
      throw error;
    }
  }

  async getVersionInfo(): Promise<DiagnosticsInfo> {
    const detected = await this.ensureDetected();
    const isRunning = await this.executor.isPhotoshopRunning();
    const executionModesAvailable = await this.getExecutionModesAvailable();

    try {
      const result = (await this.executeScript(
        `
(function() {
  return [app.name, app.version, app.build].join('||');
})();
        `.trim(),
        30000
      )) as string;

      const parts = String(result).split('||');
      const parsed = {
        name: parts[0],
        version: parts[1],
        build: parts[2],
      };

      return {
        name: parsed.name || 'Adobe Photoshop',
        version: parsed.version || detected.version || 'Unknown',
        build: parsed.build || 'Unknown',
        detectedPath: detected.path,
        detectedYear: detected.detectedYear || detected.version || 'Unknown',
        isRunning: await this.executor.isPhotoshopRunning(),
        canExecuteScript: true,
        executionModesAvailable,
      };
    } catch (error) {
      this.logger.warn('Smoke execution failed while gathering version info', error);
      return {
        name: detected.appName || 'Adobe Photoshop',
        version: detected.version || 'Unknown',
        build: 'Unknown',
        detectedPath: detected.path,
        detectedYear: detected.detectedYear || detected.version || 'Unknown',
        isRunning,
        canExecuteScript: false,
        executionModesAvailable,
      };
    }
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    const operation = operationContext.getStore();
    if (!operation) {
      const result = this.directQueue.then(async () => {
        if (this.faulted) throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
        await this.directLock.acquire();
        try {
          return await operationContext.run(
            { lock: this.directLock, isStopping: () => false },
            () => this.executeScript(script, timeout)
          );
        } finally {
          await this.directLock.release();
        }
      });
      this.directQueue = result.catch(() => undefined);
      return await result;
    }
    try {
      if (this.faulted) throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
      if (operation.lock.faulted) throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
      if (operation.isStopping()) throw new Error('SERVER_STOPPING');
      const scope = this.scope.getStore();
      if (scope) await scope.recheck();
      const detected = await this.ensureDetected();

      // Set app name for macOS executor
      if (this.macosExecutor && detected.appName) {
        this.macosExecutor.setAppName(detected.appName);
      }

      // Check if Photoshop is running, launch if needed
      const isRunning = await this.executor.isPhotoshopRunning();
      if (!isRunning) {
        throw new Error(
          'Photoshop is not running. Open it manually; automatic launch is disabled.'
        );
      }

      // Execute the script
      // Scope guard failures are completed script responses, not COM transport failures.
      const guarded = scope
        ? `(function() {
        try { return ${this.guardScript(script, scope)} }
        catch (error) { return JSON.stringify({__mcp_scope_error: String(error.message || error)}); }
      })();`
        : script;
      if (operation.isStopping()) throw new Error('SERVER_STOPPING');
      await operation.lock.beginDispatch();
      let result: unknown;
      if (operation.isStopping()) {
        await operation.lock.completeDispatch('not-started');
        throw new Error('SERVER_STOPPING');
      }
      try {
        result = await this.executor.execute(guarded, timeout);
      } catch (error) {
        const classified =
          error instanceof ScriptExecutionError
            ? error
            : new ScriptExecutionError('SCRIPT_EXECUTION_FAILED', 'unknown');
        if (classified.completion === 'unknown') this.faulted = true;
        await operation.lock.completeDispatch(classified.completion);
        throw classified;
      }
      await operation.lock.completeDispatch('finished');
      if (result && typeof result === 'object' && '__mcp_scope_error' in result)
        throw new ScriptExecutionError(String(result.__mcp_scope_error), 'finished');
      this.photoshopInfo = {
        ...detected,
        isRunning: true,
      };
      return result;
    } catch (error) {
      if (operation?.lock.faulted) this.faulted = true;
      this.logger.error('Script execution failed');
      throw error;
    }
  }

  getPhotoshopInfo(): PhotoshopInfo | null {
    return this.photoshopInfo;
  }

  async ensurePhotoshopRunning(): Promise<void> {
    await this.ensureDetected();

    const isRunning = await this.executor.isPhotoshopRunning();
    if (!isRunning) {
      throw new Error('Automatic launch disabled. Open Photoshop manually.');
    }
  }

  async getExecutionModesAvailable(): Promise<ExecutionMode[]> {
    return ['script'];
  }

  async withScope<T>(scope: ScriptScope, operation: () => Promise<T>): Promise<T> {
    await this.ensureDetected();
    return await this.scope.run(scope, operation);
  }

  /** Internal metadata only. Never forward this result to a client. */
  async inspectDocuments(): Promise<{ id: number; path: string | null }[]> {
    await this.ensureDetected();
    const api = await new PhotoshopAPIFactory(this).createAPI();
    const install = !this.epochInstalled;
    // Latch before dispatch: an ambiguous response must never reinstall identity.
    this.epochInstalled = true;
    const result = (await api.executeScript(`
      ${
        install
          ? `
      var descriptor = new ActionDescriptor();
      descriptor.putString(stringIDToTypeID('token'), ${toExtendScriptValue(this.epoch)});
      app.putCustomOptions(${toExtendScriptValue('__mcp_' + this.epoch)}, descriptor, false);
      `
          : ''
      }
      ${this.checkEpochScript()}
      var records = [];
      for (var i = 0; i < app.documents.length; i++) {
        var d = app.documents[i]; var p = null;
        try { p = d.fullName.fsName; } catch (_) {}
        records.push({id: d.id, path: p});
      }
      return records;
    `)) as { id: number; path: string | null }[];
    return result;
  }

  private checkEpochScript(): string {
    return `
      var sessionToken;
      try {
        sessionToken = app.getCustomOptions(${toExtendScriptValue('__mcp_' + this.epoch)}).getString(stringIDToTypeID('token'));
      } catch (_) { throw new Error('PHOTOSHOP_SESSION_CHANGED'); }
      if (sessionToken !== ${toExtendScriptValue(this.epoch)}) throw new Error('PHOTOSHOP_SESSION_CHANGED');
    `;
  }

  private guardScript(script: string, scope: ScriptScope): string {
    if (scope.documentId === undefined)
      return `(function() {
      ${this.checkEpochScript()}
      var dialogs = app.displayDialogs;
      try { app.displayDialogs = DialogModes.NO; return ${script} }
      finally { app.displayDialogs = dialogs; }
    })();`;
    const expected = toExtendScriptValue(scope.documentPath ?? null);
    // Selection and operation run in ONE Photoshop script. A user switching the
    // active document between MCP calls cannot redirect the operation.
    return `(function() {
  ${this.checkEpochScript()}
  var target = null;
  for (var i = 0; i < app.documents.length; i++) {
    if (app.documents[i].id === ${scope.documentId}) { target = app.documents[i]; break; }
  }
  if (!target) throw new Error('TARGET_DOCUMENT_CHANGED');
  var actual = null;
  try { actual = target.fullName.fsName; } catch (_) {}
  var expected = ${expected};
  if (expected === null ? actual !== null : (actual === null || ${process.platform === 'win32' ? 'new File(actual).fsName.toLowerCase() !== new File(expected).fsName.toLowerCase()' : 'new File(actual).fsName !== new File(expected).fsName'})) throw new Error('TARGET_PATH_CHANGED');
  app.activeDocument = target;
  ${
    scope.layerId === undefined
      ? ''
      : `
  function findLayer(container, id) {
    for (var j = 0; j < container.layers.length; j++) {
      var layer = container.layers[j];
      if (layer.id === id) return layer;
      if (layer.typename === 'LayerSet') { var found = findLayer(layer, id); if (found) return found; }
    }
    return null;
  }
  var selected = findLayer(target, ${scope.layerId});
  if (!selected) throw new Error('TARGET_LAYER_CHANGED');
  target.activeLayer = selected;
  `
  }
  var dialogs = app.displayDialogs;
  try { app.displayDialogs = DialogModes.NO; return ${script} }
  finally { app.displayDialogs = dialogs; }
})();`;
  }

  private async ensureDetected(): Promise<PhotoshopInfo> {
    if (!this.photoshopInfo) {
      this.photoshopInfo = await this.detector.detect();
    }

    return this.photoshopInfo;
  }
}
