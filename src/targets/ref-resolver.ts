import type { DocumentRef, LayerRef } from '../core/models.js';

export function normalizeDocumentRef(value: unknown): DocumentRef {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<DocumentRef>;
    if (
      candidate.by === 'active' ||
      candidate.by === 'id' ||
      candidate.by === 'name' ||
      candidate.by === 'index'
    ) {
      return {
        by: candidate.by,
        value: candidate.value,
      };
    }
  }

  return { by: 'active' };
}

export function normalizeLayerRef(value: unknown): LayerRef {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<LayerRef>;
    if (
      candidate.by === 'active' ||
      candidate.by === 'id' ||
      candidate.by === 'name' ||
      candidate.by === 'index' ||
      candidate.by === 'path'
    ) {
      return {
        by: candidate.by,
        value: candidate.value,
      };
    }
  }

  return { by: 'active' };
}
