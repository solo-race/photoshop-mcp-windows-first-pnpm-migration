import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { categorizeError } from '../core/error-taxonomy.js';
import type {
  CheckpointRecord,
  DiagnosticsInfo,
  DocumentRef,
  LayerRef,
  ResponseDetail,
} from '../core/models.js';
import { responseDetailFromArgs } from '../core/result.js';
import { toPlainObject } from '../core/serializer.js';
import { Session } from '../core/session.js';
import { PhotoshopConnection } from '../platform/connection.js';
import {
  buildCheckpointMarkerScript,
  buildDuplicateDocumentScript,
  buildFindLayersScript,
  buildGetActiveContextScript,
  buildGetDocumentTreeScript,
  buildGetHistoryScript,
  buildGetLayerInfoScript,
  buildGetLayerTreeScript,
  buildGetOpenDocumentsScript,
  buildGetSelectionBoundsScript,
  buildGetStateScript,
  buildResizeCanvasScript,
  buildSaveCopyScript,
  buildSelectDocumentScript,
  buildSelectHistoryStateScript,
  buildSelectLayerScript,
} from './script-library.js';

export class PhotoshopStateService {
  constructor(
    private readonly connection: PhotoshopConnection,
    private readonly session: Session
  ) {}

  private async api() {
    const factory = new PhotoshopAPIFactory(this.connection);
    return await factory.createAPI();
  }

  private async runScript<T>(script: string): Promise<T> {
    const api = await this.api();
    return (await api.executeScript(script)) as T;
  }

  async getDiagnostics(): Promise<DiagnosticsInfo> {
    return await this.connection.getVersionInfo();
  }

  async getState(detail: ResponseDetail): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetStateScript(detail)));
  }

  async getOpenDocuments(detail: ResponseDetail): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetOpenDocumentsScript(detail)));
  }

  async getDocumentTree(detail: ResponseDetail): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetDocumentTreeScript(detail)));
  }

  async getActiveContext(detail: ResponseDetail): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetActiveContextScript(detail)));
  }

  async getLayerTree(
    documentRef: DocumentRef | undefined,
    detail: ResponseDetail
  ): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetLayerTreeScript(documentRef, detail)));
  }

  async getLayerInfo(
    documentRef: DocumentRef | undefined,
    layerRef: LayerRef | undefined,
    detail: ResponseDetail
  ): Promise<Record<string, unknown>> {
    return toPlainObject(
      await this.runScript(buildGetLayerInfoScript(documentRef, layerRef, detail))
    );
  }

  async getSelectionBounds(documentRef?: DocumentRef): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetSelectionBoundsScript(documentRef)));
  }

  async getHistory(
    documentRef: DocumentRef | undefined,
    detail: ResponseDetail
  ): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildGetHistoryScript(documentRef, detail)));
  }

  async findLayers(
    documentRef: DocumentRef | undefined,
    query: string,
    mode: 'contains' | 'exact',
    textOnly = false
  ): Promise<Record<string, unknown>> {
    return toPlainObject(
      await this.runScript(buildFindLayersScript(documentRef, query, mode, textOnly))
    );
  }

  async selectDocument(documentRef?: DocumentRef): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildSelectDocumentScript(documentRef)));
  }

  async selectLayer(
    documentRef: DocumentRef | undefined,
    layerRef: LayerRef | undefined
  ): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildSelectLayerScript(documentRef, layerRef)));
  }

  async selectHistoryState(
    documentRef: DocumentRef | undefined,
    stateRef: string | number
  ): Promise<Record<string, unknown>> {
    return toPlainObject(
      await this.runScript(buildSelectHistoryStateScript(documentRef, stateRef))
    );
  }

  async duplicateDocument(
    documentRef: DocumentRef | undefined,
    newName?: string
  ): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildDuplicateDocumentScript(documentRef, newName)));
  }

  async resizeCanvas(
    documentRef: DocumentRef | undefined,
    width: number,
    height: number
  ): Promise<Record<string, unknown>> {
    return toPlainObject(await this.runScript(buildResizeCanvasScript(documentRef, width, height)));
  }

  async saveCopy(
    documentRef: DocumentRef | undefined,
    path: string,
    format: 'PSD' | 'JPEG' | 'PNG',
    quality: number
  ): Promise<Record<string, unknown>> {
    return toPlainObject(
      await this.runScript(buildSaveCopyScript(documentRef, path, format, quality))
    );
  }

  async assertState(assertions: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.getState(responseDetailFromArgs(assertions.responseDetail));
    const activeDocument = toPlainObject(state.activeDocument);
    const activeLayer = toPlainObject(state.activeLayer);
    const failures: string[] = [];

    if (assertions.requiresDocument && !state.hasDocument) {
      failures.push('Expected an active document.');
    }

    if (
      typeof assertions.documentNameContains === 'string' &&
      !String(activeDocument.name || '').includes(assertions.documentNameContains)
    ) {
      failures.push(`Active document name does not include "${assertions.documentNameContains}".`);
    }

    if (
      typeof assertions.activeLayerName === 'string' &&
      String(activeLayer.name || '') !== assertions.activeLayerName
    ) {
      failures.push(`Active layer is not "${assertions.activeLayerName}".`);
    }

    if (
      typeof assertions.minimumLayerCount === 'number' &&
      Number(activeDocument.layerCount || 0) < assertions.minimumLayerCount
    ) {
      failures.push(
        `Expected at least ${assertions.minimumLayerCount} layers, found ${activeDocument.layerCount || 0}.`
      );
    }

    if (
      typeof assertions.hasSelection === 'boolean' &&
      Boolean(activeDocument.hasSelection) !== assertions.hasSelection
    ) {
      failures.push(`Expected hasSelection=${assertions.hasSelection}.`);
    }

    return {
      passed: failures.length === 0,
      failures,
      state,
    };
  }

  async waitForIdle(timeoutMs: number, intervalMs: number): Promise<Record<string, unknown>> {
    const start = Date.now();
    let attempts = 0;

    while (Date.now() - start < timeoutMs) {
      attempts += 1;

      try {
        const state = await this.getState('minimal');
        return {
          idle: true,
          attempts,
          waitedMs: Date.now() - start,
          state,
        };
      } catch (error) {
        this.session.recordError(categorizeError(error, 'photoshop_wait_for_idle'));
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for Photoshop to become idle after ${timeoutMs}ms`);
  }

  async createCheckpoint(name: string, documentRef?: DocumentRef): Promise<CheckpointRecord> {
    const marker = toPlainObject(await this.runScript(buildCheckpointMarkerScript(documentRef)));
    const record: CheckpointRecord = {
      name,
      createdAt: new Date().toISOString(),
      historyStateName:
        typeof marker.historyStateName === 'string' ? marker.historyStateName : null,
      state: await this.getState('normal'),
    };

    this.session.saveCheckpoint(record);
    return record;
  }

  async restoreCheckpoint(name: string): Promise<Record<string, unknown>> {
    const checkpoint = this.session.getCheckpoint(name);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${name}`);
    }

    if (checkpoint.historyStateName) {
      return await this.selectHistoryState(undefined, checkpoint.historyStateName);
    }

    return {
      restored: false,
      reason: 'Checkpoint did not include a Photoshop history state reference.',
      checkpoint,
    };
  }
}
