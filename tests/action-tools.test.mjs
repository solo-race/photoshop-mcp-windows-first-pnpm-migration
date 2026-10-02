import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../dist/core/tool-registry.js';
import { disabledTools } from '../dist/security/tool-policy.js';

test('removed tool names cannot be registered or invoked', async () => {
  const registry = new ToolRegistry();
  for (const name of disabledTools) {
    assert.throws(() => registry.register(name, {tool: {name, inputSchema: {type: 'object'}}, handler: async () => ({content: []})}), /TOOL_DISABLED/);
    await assert.rejects(registry.execute(name, {}), /TOOL_DISABLED/);
  }
  assert.deepEqual(registry.list(), []);
});
