import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { ExtendScriptSnippets as snippets } from '../dist/api/extendscript.js';
import { samePath, inside, matchesGrantedPath, ProjectPolicy } from '../dist/security/project-policy.js';
import { ToolPolicy } from '../dist/security/tool-policy.js';

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

test('Windows document/output/overwrite paths share case-aware identity; POSIX remains case sensitive', () => {
  for (const flavor of [path.win32, path.posix]) {
    const root = flavor === path.win32 ? 'C:\\Projects\\art' : '/projects/art';
    for (const directory of ['masters', 'work', 'previews']) {
      const approved = `${directory}/Example.psd`;
      const exact = flavor.join(root, approved);
      const variant = flavor.join(root, directory, 'example.psd');
      assert.equal(matchesGrantedPath(root, [approved], exact, flavor), true);
      assert.equal(samePath(exact, variant, flavor), flavor === path.win32);
      assert.equal(matchesGrantedPath(root, [approved], variant, flavor), flavor === path.win32);
      assert.equal(matchesGrantedPath(root, [approved], flavor.join(root, directory, 'other.psd'), flavor), false);
      assert.equal(matchesGrantedPath(root, [approved], flavor.join(root, '..', 'outside', 'Example.psd'), flavor), false);
      assert.equal(inside(root, flavor.join(root + '-other', approved), flavor), false);
      assert.throws(() => matchesGrantedPath(root, ['../outside.psd'], exact, flavor), /PATH_DENIED/);
    }
  }
});

test('grant tool/task names remain exact and explicit rasterization remains destructive-gated', () => {
  const root = path.resolve('fixture');
  const policy = new ProjectPolicy();
  const project = { root, allow_destructive: false, tasks: [{
    id: 'Edit', expires_at: '2099-01-01', tools: ['photoshop_desaturate', 'photoshop_rasterize_layer'],
    documents: ['masters/Example.psd'], destructive_tools: [],
  }] };
  const doc = path.join(root, 'masters/Example.psd');
  assert.equal(policy.grant(project, 'Edit', 'photoshop_desaturate', doc).id, 'Edit');
  assert.throws(() => policy.grant(project, 'edit', 'photoshop_desaturate', doc), /TASK_NOT_AUTHORIZED/);
  assert.throws(() => policy.grant(project, 'Edit', 'PHOTOSHOP_DESATURATE', doc), /TASK_NOT_AUTHORIZED/);
  assert.throws(() => policy.grant(project, 'Edit', 'photoshop_rasterize_layer', doc, false, true), /DESTRUCTIVE/);
});

test('safe rasterization-required guidance survives result sanitization', async () => {
  const root = path.resolve('fixture');
  const projects = {
    unchanged: async () => {}, get: () => ({ id: 'art', root }),
    documentPath: async (_, p) => p, grant: () => ({}),
  };
  const connection = {
    inspectDocuments: async () => [{id: 1, path: path.join(root, 'masters/a.psd')}],
    withScope: async (_, fn) => fn(),
  };
  const guard = new ToolPolicy(projects, connection);
  const definition = guard.decorate({
    tool: {name: 'photoshop_desaturate', inputSchema: {type: 'object', properties: {}}},
    handler: async () => ({ isError: true, content: [{type: 'text', text: 'RASTERIZATION_REQUIRED private/path'}] }),
  });
  const result = await guard.run(definition, {project_id: 'art', task_id: 'Edit', document_id: 1, layer_id: 2});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /separately authorize photoshop_rasterize_layer/);
  assert.doesNotMatch(result.content[0].text, /private/);
});

test('case-sensitive filesystem files remain distinct and aliases stay denied', async () => {
  if (process.platform === 'win32') return; // Windows semantics are covered by the bounded path probe above.
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const temp = await mkdtemp(path.join(tmpdir(), 'ps-review-'));
  try {
    const root = path.join(temp, 'project');
    await mkdir(path.join(root, 'masters'), { recursive: true });
    await writeFile(path.join(root, 'masters/Example.psd'), 'one');
    await writeFile(path.join(root, 'masters/example.psd'), 'two');
    const project = {
      id: 'art', root, read_paths: ['masters'], write_paths: [], allow_overwrite: false,
      allow_destructive: false, allow_ui_capture: false, preview_delivery: 'local-only', cloud_recipients: [],
      tasks: [{ id: 'edit', expires_at: '2099-01-01', tools: ['photoshop_desaturate'], documents: ['masters/Example.psd'] }],
    };
    const config = path.join(temp, 'policy.json');
    await writeFile(config, JSON.stringify({schema_version: 1, projects: [project]}));
    const policy = await ProjectPolicy.load(config);
    const approved = await policy.documentPath(policy.get('art'), path.join(root, 'masters/Example.psd'));
    const other = await policy.documentPath(policy.get('art'), path.join(root, 'masters/example.psd'));
    policy.grant(project, 'edit', 'photoshop_desaturate', approved);
    assert.throws(() => policy.grant(project, 'edit', 'photoshop_desaturate', other), /TASK_DOCUMENT_DENIED/);
    await symlink(approved, path.join(root, 'masters/alias.psd'));
    await assert.rejects(policy.documentPath(project, path.join(root, 'masters/alias.psd')), /ALIAS_DENIED/);
  } finally { await rm(temp, {recursive: true, force: true}); }
});
