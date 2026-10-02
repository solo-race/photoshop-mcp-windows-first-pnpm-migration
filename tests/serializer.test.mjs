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

test('internal API response encoding preserves JSON quotes and control characters', async () => {
  const {PhotoshopAPIFactory} = await import('../dist/api/photoshop-api.js');
  const {runInNewContext} = await import('node:vm');
  const sample = 'quoted " text \\ newline\n tab\t\b\f\r\u0001\u2028\u2029终点';
  const connection = {
    getPhotoshopInfo: () => ({version:'2025'}),
    executeScript: async (script) => JSON.parse(runInNewContext(script)),
  };
  const api = await new PhotoshopAPIFactory(connection).createAPI();
  assert.equal(await api.executeScript(`return ${toExtendScriptValue(sample)};`), sample);
});
