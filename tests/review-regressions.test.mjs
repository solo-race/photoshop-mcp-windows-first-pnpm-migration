import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ExtendScriptSnippets as snippets } from '../dist/api/extendscript.js';
import { ToolExecutor } from '../dist/core/tool-executor.js';

const operations = [
  ['applyGaussianBlur', [2], 'applyGaussianBlur'],
  ['applyUnsharpMask', [50, 2, 0], 'applyUnSharpMask'],
  ['applyAddNoise', [5, 'UNIFORM', false], 'applyAddNoise'],
  ['applyMotionBlur', [0, 2], 'applyMotionBlur'],
  ['adjustBrightnessContrast', [5, 5], 'adjustBrightnessContrast'],
  ['adjustHueSaturation', [5, 5, 5], 'executeAction'],
  ['autoLevels', [], 'autoLevels'],
  ['autoContrast', [], 'autoContrast'],
  ['desaturate', [], 'desaturate'],
  ['invert', [], 'invert'],
];
for (const [name, args, method] of operations) {
  test(`${name}: NORMAL works; other layer kinds refuse without conversion or edits`, () => {
    for (const kind of ['NORMAL', 'TEXT', 'SMARTOBJECT', 'SOLIDFILL']) {
      let edits = 0, rasterizations = 0;
      const layer = { kind, rasterize() { rasterizations++; }, [method]() { edits++; } };
      const doc = { activeLayer: layer, layers: [layer], width: { as: () => 100 }, height: { as: () => 100 } };
      const context = {
        app: { documents: [doc], activeDocument: doc },
        LayerKind: { NORMAL: 'NORMAL', TEXT: 'TEXT', SMARTOBJECT: 'SMARTOBJECT' },
        NoiseDistribution: { UNIFORM: 1 },
        ActionDescriptor: function () { this.putBoolean = this.putInteger = this.putList = () => {}; },
        ActionList: function () { this.putObject = () => {}; },
        charIDToTypeID: (v) => v, DialogModes: { NO: 0 },
        executeAction() { edits++; },
      };
      const run = () => vm.runInNewContext(`(function () { ${snippets[name](...args)} })()`, context);
      if (kind === 'NORMAL') { run(); assert.equal(edits, 1); }
      else { assert.throws(run, /RASTERIZATION_REQUIRED/); assert.equal(edits, 0); }
      assert.equal(rasterizations, 0);
      assert.equal(layer.kind, kind);
    }
  });
}

test('rasterization guidance survives result sanitization without exposing internal errors', async () => {
  const connection = {
    inspectDocuments: async () => [{ id: 1, path: null }],
    withScope: async (_, fn) => fn(),
  };
  const executor = new ToolExecutor(connection);
  const definition = executor.decorate({
    tool: { name: 'photoshop_desaturate', inputSchema: { type: 'object', properties: {} } },
    handler: async () => ({ isError: true, content: [{ type: 'text', text: 'RASTERIZATION_REQUIRED private/path' }] }),
  });
  const result = await executor.run(definition, { document_id: 1, layer_id: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /use photoshop_rasterize_layer/);
  assert.doesNotMatch(result.content[0].text, /private/);
});
