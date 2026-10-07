import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectPolicy, inside, matchesGrantedPath } from '../dist/security/project-policy.js';
import { decodePNG } from './helpers/selection-fill-native-decoder.mjs';
import {
  PROJECT_ID, TASK_ID, SOURCE_PATH, EXPORT_PATH,
  expectedRGBA, crc32, createFixturePNG, compareRGBA, withAuthorizedRoundtrip, closeOwned,
} from './helpers/selection-fill-rgba-roundtrip-gate.mjs';

// Local files and public policy only; no Photoshop connection or process execution.
test('legal PNG chunks decode the independently specified full RGBA fixture, including hidden RGB', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
  const png = createFixturePNG(), types = [];
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let position = 8;
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    const body = png.subarray(position + 4, position + 8 + length);
    types.push(body.subarray(0, 4).toString('ascii'));
    assert.equal(png.readUInt32BE(position + 8 + length), crc32(body));
    position += length + 12;
  }
  assert.equal(position, png.length);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const expected = Buffer.from(Array.from({ length: 64 }, (_, pixel) =>
    pixel === 0 ? [101, 102, 103, 255] : pixel === 63 ? [11, 29, 53, 255] : [7, 8, 9, 0]).flat());
  const decoded = decodePNG(png);
  assert.deepEqual([decoded.width, decoded.height, decoded.channels], [8, 8, 4]);
  assert.deepEqual(decoded.rgba, expected);
  assert.deepEqual(expectedRGBA(), expected);
  assert.equal(compareRGBA(decoded).observerRepairAllowed, false);
});

test('hidden RGB normalization or incomplete pixels explicitly fail the pipeline comparison', () => {
  const decoded = decodePNG(createFixturePNG());
  const normalized = Buffer.from(decoded.rgba);
  normalized.fill(0, 4, 7); // Alpha stays zero; loss of hidden RGB still fails.
  for (const rgba of [normalized, decoded.rgba.subarray(0, 252)]) {
    assert.throws(() => compareRGBA({ ...decoded, rgba }), /RGBA_PIPELINE_NOT_PRESERVING/);
  }
});

test('real ProjectPolicy rejects each missing task addition before fixture writes or dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rgba-roundtrip-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  await mkdir(join(root, '.tmp', 'selection-fill-native'), { recursive: true });
  const tools = ['photoshop_open_image', 'photoshop_duplicate_document',
    'photoshop_export_document', 'photoshop_close_document'];
  const task = {
    id: TASK_ID, expires_at: '2099-01-01T00:00:00Z', tools,
    documents: [SOURCE_PATH], output_paths: [EXPORT_PATH], allow_new_documents: true,
    destructive_tools: ['photoshop_close_document'],
  };
  const filename = join(directory, 'policy.json');
  await writeFile(filename, JSON.stringify({ schema_version: 1, projects: [{
    id: PROJECT_ID, root, read_paths: ['.tmp/selection-fill-native'],
    write_paths: ['.tmp/selection-fill-native'], allow_overwrite: false,
    allow_destructive: true, allow_ui_capture: false,
    preview_delivery: 'local-only', cloud_recipients: [], tasks: [task],
  }] }), { flag: 'wx' });
  const projects = await ProjectPolicy.load(filename), project = projects.get(PROJECT_ID);
  const loaded = project.tasks[0];
  for (const missing of ['duplicate', 'source', 'output', 'all']) {
    loaded.tools = tools.filter(name => !((missing === 'duplicate' || missing === 'all')
      && name === 'photoshop_duplicate_document'));
    loaded.documents = missing === 'source' || missing === 'all' ? [] : [SOURCE_PATH];
    loaded.output_paths = missing === 'output' || missing === 'all' ? [] : [EXPORT_PATH];
    let dispatches = 0, fixtureWrites = 0;
    await assert.rejects(withAuthorizedRoundtrip(projects, project, { inside, matchesGrantedPath }, async () => {
      fixtureWrites++;
      dispatches++;
    }), error => {
      assert.equal(error.message, 'ROUNDTRIP_GRANT_STOP');
      const scopes = error.failures.map(failure => failure.scope);
      if (missing === 'duplicate' || missing === 'all') assert.ok(scopes.includes('duplicate-tool/source-document'));
      if (missing === 'source' || missing === 'all') assert.ok(scopes.includes('source-document'));
      if (missing === 'output' || missing === 'all') assert.ok(scopes.includes('export-output'));
      return true;
    });
    assert.equal(dispatches, 0, missing);
    assert.equal(fixtureWrites, 0, missing);
  }
});

test('cleanup closes only owned copy/source; failure stops without another close or retry', async () => {
  for (const fail of [false, true]) {
    const owned = new Set([101, 102]), calls = [], events = [];
    const registry = { execute: async (name, args) => {
      calls.push({ name, args });
      return { isError: fail, content: [] };
    } };
    const cleaned = await closeOwned(owned, registry, (event, data) => events.push({ event, data }));
    assert.equal(cleaned, !fail);
    assert.deepEqual(calls.map(call => call.args.document_id), fail ? [102] : [102, 101]);
    assert.ok(calls.every(call => call.name === 'photoshop_close_document'
      && call.args.save === false && call.args.project_id === PROJECT_ID && call.args.task_id === TASK_ID));
    assert.deepEqual([...owned], fail ? [101, 102] : []);
    assert.equal(events.at(-1).event, fail ? 'cleanup-STOP' : 'cleanup');
  }
});
