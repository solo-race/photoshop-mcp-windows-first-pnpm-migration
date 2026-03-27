import test from 'node:test';
import assert from 'node:assert/strict';
import { toExtendScriptValue } from '../dist/core/serializer.js';

test('toExtendScriptValue escapes quotes, backslashes, and newlines', () => {
  const input = 'He said "hello" in C:\\temp\nNext line';
  assert.equal(toExtendScriptValue(input), JSON.stringify(input));
});

test('toExtendScriptValue serializes plain objects', () => {
  const input = { by: 'name', value: 'Hero/Title' };
  assert.equal(toExtendScriptValue(input), JSON.stringify(input));
});
