import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutionInfo,
  createEnvelope,
  createToolResult,
} from '../dist/core/result.js';

test('createToolResult includes structuredContent and text summary', () => {
  const envelope = createEnvelope({
    ok: true,
    summary: 'Everything worked',
    data: { answer: 42 },
    execution: buildExecutionInfo('script', 'script', 12, false),
  });
  const result = createToolResult(envelope);

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.summary, 'Everything worked');
  assert.match(result.content[0].text, /Everything worked/);
});

test('createToolResult marks failed envelopes as errors', () => {
  const envelope = createEnvelope({
    ok: false,
    summary: 'Something failed',
    data: { error: 'boom' },
    execution: buildExecutionInfo('auto', 'workflow', 20, true),
  });
  const result = createToolResult(envelope);

  assert.equal(result.isError, true);
});
