import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDocumentRef,
  normalizeLayerRef,
} from '../dist/targets/ref-resolver.js';

test('normalizeDocumentRef falls back to active document', () => {
  assert.deepEqual(normalizeDocumentRef(undefined), { by: 'active' });
});

test('normalizeLayerRef preserves valid path selectors', () => {
  assert.deepEqual(normalizeLayerRef({ by: 'path', value: 'Group/Layer' }), {
    by: 'path',
    value: 'Group/Layer',
  });
});
