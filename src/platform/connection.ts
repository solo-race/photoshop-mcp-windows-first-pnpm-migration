import { platform } from 'os';
import { Logger } from '../utils/logger.js';
import { PhotoshopDetector } from './detector.js';
import { ScriptExecutor } from './script-executor.js';
import { WindowsExecutor } from './windows-executor.js';
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
  private logger: Logger;
  private detector: PhotoshopDetector;
  private executor: ScriptExecutor;
  private photoshopInfo: PhotoshopInfo | null = null;
  private macosExecutor?: MacOSExecutor;

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
      throw new Error(`Unsupported platform: ${platformType}`);
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
    try {
      const detected = await this.ensureDetected();

      // Set app name for macOS executor
      if (this.macosExecutor && detected.appName) {
        this.macosExecutor.setAppName(detected.appName);
      }

      // Check if Photoshop is running, launch if needed
      const isRunning = await this.executor.isPhotoshopRunning();
      if (!isRunning) {
        this.logger.info('Photoshop not running, launching...');
        await this.executor.launchPhotoshop(detected.path);
      }

      // Execute the script
      const result = await this.executor.execute(script, timeout);
      this.photoshopInfo = {
        ...detected,
        isRunning: true,
      };
      return result;
    } catch (error) {
      this.logger.error('Script execution failed:', error);
      throw error;
    }
  }

  getPhotoshopInfo(): PhotoshopInfo | null {
    return this.photoshopInfo;
  }

  async ensurePhotoshopRunning(): Promise<void> {
    const detected = await this.ensureDetected();

    const isRunning = await this.executor.isPhotoshopRunning();
    if (!isRunning) {
      this.logger.info('Launching Photoshop...');
      await this.executor.launchPhotoshop(detected.path);
    }
  }

  async getExecutionModesAvailable(): Promise<ExecutionMode[]> {
    const modes: ExecutionMode[] = ['script'];
    if (platform() === 'win32') {
      modes.push('ui', 'auto');
    } else {
      modes.push('auto');
    }

    return modes;
  }

  private async ensureDetected(): Promise<PhotoshopInfo> {
    if (!this.photoshopInfo) {
      this.photoshopInfo = await this.detector.detect();
    }

    return this.photoshopInfo;
  }
}
