import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ToolExecutor } from '../dist/core/tool-executor.js';
import { createAdvancedTools } from '../dist/tools/advanced-tools.js';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

test('an unsaved document can be edited by document/layer IDs without project or task registration', async () => {
  const calls = [];
  const executor = new ToolExecutor({
    inspectDocuments: async () => [{ id: 7, path: null }],
    withScope: async (scope, run) => { calls.push(scope); return run(); },
  });
  const definition = executor.decorate({
    tool: { name: 'photoshop_rename_layer', inputSchema: {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    } },
    handler: async (args) => text(args),
  });
  const args = { document_id: 7, layer_id: 8, name: 'Working layer' };
  assert.deepEqual(JSON.parse((await executor.run(definition, args)).content[0].text), args);
  assert.deepEqual(calls, [{ documentId: 7, documentPath: undefined, layerId: 8 }]);
  await assert.rejects(executor.run(definition, { ...args, document_id: 99 }), /DOCUMENT_NOT_FOUND/);
  await assert.rejects(executor.run(definition, { ...args, layer_id: 0 }), /INVALID_ARGUMENT/);
  await assert.rejects(executor.run(definition, { ...args, project_id: 'old' }), /UNKNOWN_ARGUMENT/);
  assert.equal(calls.length, 1);
});

test('open document discovery includes saved and unsaved documents without root filtering', async () => {
  const documents = [{ id: 1, path: path.resolve('one.psd') }, { id: 2, path: null }];
  const connection = { inspectDocuments: async () => documents };
  const executor = new ToolExecutor(connection);
  const definition = executor.decorate(createAdvancedTools(connection, async () => assert.fail())
    .find((entry) => entry.tool.name === 'photoshop_get_open_documents'));
  const result = await executor.run(definition, {});
  assert.deepEqual(JSON.parse(result.content[0].text), { documents });
});

test('file paths resolve against the host working directory and accept absolute paths', async () => {
  const seen = [];
  const executor = new ToolExecutor({
    inspectDocuments: async () => [{ id: 7, path: null }],
    withScope: async (_, run) => run(),
  });
  const definition = executor.decorate({
    tool: { name: 'photoshop_export_document', inputSchema: {
      type: 'object', properties: {
        path: { type: 'string' }, format: { type: 'string', enum: ['PNG', 'JPEG'] },
      }, required: ['path', 'format'],
    } },
    handler: async (args) => { seen.push(args.path); return text({ exported: true }); },
  });
  for (const file of ['../output/preview.png', path.resolve('output/preview.png')]) {
    await executor.run(definition, { document_id: 7, path: file, format: 'PNG' });
    assert.equal(seen.at(-1), path.resolve(file));
  }
  await assert.rejects(executor.run(definition, {
    document_id: 7, path: '../output/preview.psd', format: 'PNG',
  }), /FORMAT_EXTENSION_MISMATCH/);
  assert.equal(seen.length, 2);
});
