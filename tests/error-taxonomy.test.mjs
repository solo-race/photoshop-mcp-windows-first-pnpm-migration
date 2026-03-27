import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeError } from '../dist/core/error-taxonomy.js';

test('categorizeError recognizes missing document', () => {
  const record = categorizeError(new Error('No active document'), 'photoshop_get_state');
  assert.equal(record.category, 'no-document');
  assert.equal(record.toolName, 'photoshop_get_state');
});

test('categorizeError recognizes dialog blocking states', () => {
  const record = categorizeError('A modal dialog is open', 'photoshop_ping');
  assert.equal(record.category, 'dialog-blocked');
  assert.equal(record.retryable, true);
});
