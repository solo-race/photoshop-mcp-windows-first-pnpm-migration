import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  EVIDENCE_PATH, VARIANTS, expectedShape, validateShape, validateNoRawState,
  validateRestoration, validateBracket, passEvidence, producerScript, readiness, main,
  registerNoRawDocumentTools,
} from './helpers/selection-fill-native-no-raw-gate.mjs';
import { NO_RAW_REQUIREMENTS, NO_RAW_GATE_PATH, requireNoRawGate } from './helpers/selection-fill-native-probe.mjs';
import { cleanupOwnedAfterFailure } from './helpers/selection-fill-full-observation-gate.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const docFor = variant => ({ id: 71, layer: 3, variant });
function snapshot(doc, shape = 'four') {
  const names = doc.variant === 'gray' ? ['Gray'] : ['Red', 'Green', 'Blue'];
  const channels = names.map(name => ({ name, kind: 'ChannelType.COMPONENT' }));
  return {
    hasSelection: true, bounds: shape === 'one' ? [2,3,3,4] : [1,1,7,7],
    active: { document_id: doc.id, layer_id: doc.layer }, history: { id: 15, count: 6 },
    state: {
      document: { id: doc.id, name: 'Owned', width: 8, height: 8, saved: false },
      mode: doc.variant === 'gray' ? 'DocumentMode.GRAYSCALE' : 'DocumentMode.RGB',
      depth: doc.variant === 'gray' ? 'BitsPerChannelType.EIGHT' : 'BitsPerChannelType.SIXTEEN',
      layers: [{ id: doc.layer, kind: 'LayerKind.NORMAL', visible: true, opacity: 100, mask: { hasUserMask: false } }],
      target: { method: 'getter' }, channels,
      componentRoster: channels.map(row => ({ ...row, component: true })),
      allChannels: channels.map((row, index) => ({ ...row, index, visible: true, histogram: null,
        histogramAvailability: { available: false, reason: 'non-rgb-source-pixels-not-measured' } })),
    },
  };
}
function full(doc, shape) {
  return { ...snapshot(doc, shape), ok: true, shape: expectedShape(shape), counts: Array(64).fill(1),
    cleanup: ['copy-closed', 'alpha-removed'] };
}
const passRows = () => VARIANTS.map(variant => ({ variant, closed: true,
  ...Object.fromEntries(NO_RAW_REQUIREMENTS.map(key => [key, true])) }));

test('independent one/four raw64 literals require every count and completed cleanup', () => {
  for (const [shape, indices] of [['one', [26]], ['four', [9,13,42,54]]]) {
    const literal = Array(64).fill(0); for (const index of indices) literal[index] = 255;
    assert.deepEqual(expectedShape(shape), literal);
    const observed = full(docFor('gray'), shape); validateShape(observed, shape);
    for (const field of ['shape', 'counts']) {
      const missing = clone(observed); delete missing[field]; assert.throws(() => validateShape(missing, shape));
    }
    const inverted = clone(observed); inverted.shape = inverted.shape.map(value => 255 - value);
    assert.throws(() => validateShape(inverted, shape), /FULL_64_RAW_SHAPE_GATE/);
    const badCount = clone(observed); badCount.counts[63] = 2;
    assert.throws(() => validateShape(badCount, shape), /FULL_64_COUNT_GATE/);
    assert.throws(() => validateShape({ ...observed, cleanupFailed: true }, shape), /CLEANUP_GATE/);
    assert.throws(() => validateShape({ ...observed, cleanup: ['copy-closed'] }, shape), /CLEANUP_GATE/);
  }
});

test('Gray/16 original mode, depth, metadata and histogram absence must restore exactly', () => {
  for (const variant of VARIANTS) {
    const doc = docFor(variant), before = snapshot(doc), observed = full(doc, 'four'), after = clone(before);
    after.history = { id: 30, count: 10 };
    validateRestoration(before, observed, after, doc, 'four');
    for (const mutate of [
      state => { state.mode = 'DocumentMode.CMYK'; },
      state => { state.depth = 'BitsPerChannelType.THIRTYTWO'; },
      state => { state.allChannels[0].histogram = [1]; },
      state => { state.allChannels[0].histogramAvailability.available = true; },
    ]) {
      const invalid = clone(before); mutate(invalid.state);
      assert.throws(() => validateNoRawState(invalid, doc, 'four'));
    }
    const changed = clone(after); changed.state.layers[0].mask.hasUserMask = true;
    assert.throws(() => validateRestoration(before, observed, changed, doc, 'four'), /SOURCE_STATE_RESTORED_GATE/);
    const visibility = clone(after); visibility.state.allChannels[0].visible = false;
    assert.throws(() => validateRestoration(before, observed, visibility, doc, 'four'), /SOURCE_STATE_RESTORED_GATE/);
  }
});

test('stable/readonly brackets require deep equality and fixed one-pixel write requires new history', () => {
  for (const variant of VARIANTS) {
    const doc = docFor(variant), before = snapshot(doc);
    validateBracket({ before, after: clone(before), result: null }, doc, 'four', 'stable');
    validateBracket({ before, after: clone(before), result: { producer: 'readonly-noop' } }, doc, 'four', 'readonly');
    const unstable = clone(before); unstable.history.id++;
    assert.throws(() => validateBracket({ before, after: unstable }, doc, 'four', 'stable'), /STABILITY_GATE/);
    const one = snapshot(doc, 'one'), after = clone(one); after.history.id++; after.history.count++;
    const write = { before: one, after, result: { producer: 'black-selection-fill' } };
    validateBracket(write, doc, 'one', 'black-write');
    assert.throws(() => validateBracket({ ...write, after: clone(one) }, doc, 'one', 'black-write'), /HISTORY_CHANGE_GATE/);
    assert.throws(() => validateBracket({ ...write, result: { producer: 'echo' } }, doc, 'one', 'black-write'), /ACTUAL_WRITE_PRODUCER_REQUIRED/);
    const noHistory = clone(after); delete noHistory.history;
    assert.throws(() => validateBracket({ ...write, after: noHistory }, doc, 'one', 'black-write'), /HISTORY_REQUIRED/);
    const wrongSelection = clone(after); wrongSelection.bounds = [1,1,7,7];
    assert.throws(() => validateBracket({ ...write, after: wrongSelection }, doc, 'one', 'black-write'), /BOUNDS_GATE/);
  }
});

test('fixed producer actually fills white then black and readonly changes no Photoshop state', () => {
  for (const variant of VARIANTS) {
    const doc = docFor(variant), calls = [], unit = value => ({ as: () => value });
    const d = { id: doc.id, activeLayer: { id: doc.layer }, width: unit(8), height: unit(8), layers: [{}],
      selection: {
        bounds: [2,3,3,4].map(unit), selectAll() { calls.push('select-all'); },
        deselect() { calls.push('deselect'); },
        fill(color, blend, opacity, preserve) { calls.push(['fill', color.rgb.red, color.rgb.green, color.rgb.blue, blend, opacity, preserve]); },
      },
    };
    for (const [key, value] of [['mode', variant === 'gray' ? 'gray' : 'rgb'], ['bitsPerChannel', variant === 'gray' ? 8 : 16]])
      Object.defineProperty(d, key, { get: () => value, set() { throw new Error('ORIGINAL_MODE_DEPTH_WRITE'); } });
    Object.defineProperty(d, 'channels', { get() { throw new Error('ORIGINAL_CHANNEL_HISTOGRAM_READ'); } });
    const context = { app: { activeDocument: d }, DocumentMode: { GRAYSCALE: 'gray', RGB: 'rgb' },
      BitsPerChannelType: { EIGHT: 8, SIXTEEN: 16 }, ColorBlendMode: { NORMAL: 'normal' },
      SolidColor: function () { this.rgb = {}; } };
    const execute = action => vm.runInNewContext('(function(){' + producerScript(doc, action) + '})()', context);
    assert.equal(execute('white-baseline').producer, 'white-full-baseline');
    assert.deepEqual(calls, ['select-all', ['fill',255,255,255,'normal',100,false], 'deselect']);
    calls.length = 0;
    assert.equal(execute('black-write').producer, 'black-selection-fill');
    assert.deepEqual(calls, [['fill',0,0,0,'normal',100,false]]);
    calls.length = 0; assert.equal(execute('readonly').producer, 'readonly-noop'); assert.deepEqual(calls, []);
    d.selection.bounds = [1,1,7,7].map(unit);
    assert.throws(() => execute('black-write'), /FIXED_ONE_SELECTION_GATE/); assert.deepEqual(calls, []);
  }
});

test('missing criteria or failed/unknown owned cleanup cannot grant matrixAllowed', async () => {
  const rows = passRows(); assert.equal(requireNoRawGate(passEvidence(rows, [])).matrixAllowed, true);
  for (const key of NO_RAW_REQUIREMENTS) {
    const missing = clone(rows); delete missing[0][key]; assert.throws(() => passEvidence(missing, []), /NO_RAW_CRITERION/);
    const failed = clone(rows); failed[1][key] = false; assert.throws(() => passEvidence(failed, []), /NO_RAW_CRITERION/);
  }
  assert.throws(() => passEvidence([rows[0]], []), /BOTH_NO_RAW_CASES_REQUIRED/);
  assert.throws(() => passEvidence(rows, [71]), /OWNED_REMAINING_GATE/);
  const notClosed = clone(rows); notClosed[0].closed = false;
  assert.throws(() => passEvidence(notClosed, []), /OWNED_CLOSE_REQUIRED/);
  const owned = new Set([71,74]), calls = [];
  const cleanup = await cleanupOwnedAfterFailure({ owned, registry: {}, connection: { isFaulted: false },
    error: new Error('local shape failure'), close: async doc => { calls.push(doc.id); throw new Error('close failed'); } });
  assert.equal(cleanup.status, 'STOP'); assert.deepEqual(calls, [71]);
  assert.throws(() => passEvidence(rows, [...owned]), /OWNED_REMAINING_GATE/);
  for (const options of [{ error: { completion: 'unknown' } }, { cleanupFailed: true }]) {
    calls.length = 0;
    await cleanupOwnedAfterFailure({ owned, registry: {}, connection: { isFaulted: false },
      close: async doc => { calls.push(doc.id); }, ...options });
    assert.deepEqual(calls, []); assert.throws(() => passEvidence(rows, [...owned]), /OWNED_REMAINING_GATE/);
  }
});

test('real document/advanced factories register the actual context getter without other advanced tools', async () => {
  const [{ createDocumentTools }, { createAdvancedTools }, { ToolRegistry }] = await Promise.all([
    import('../dist/tools/document-tools.js'), import('../dist/tools/advanced-tools.js'),
    import('../dist/core/tool-registry.js'),
  ]);
  const calls = [], context = { document_id: 976, activeLayer: { id: 2 } };
  const connection = {
    getPhotoshopInfo: () => ({ version: '26.0' }),
    executeScript: async script => { calls.push(script); return { ok: true, result: context }; },
  };
  const registry = new ToolRegistry();
  const documents = createDocumentTools(connection);
  const advanced = createAdvancedTools(connection, () => assert.fail('Unexpected advanced subcall'));
  const getter = advanced.find(definition => definition.tool.name === 'photoshop_get_active_context');
  assert.ok(getter && typeof getter.handler === 'function');
  assert.equal(documents.some(definition => definition.tool.name === getter.tool.name), false);
  const factories = { createDocumentTools: () => documents, createAdvancedTools: () => advanced };
  registerNoRawDocumentTools(registry, connection, factories);
  assert.deepEqual(calls, []);
  assert.equal(registry.get(getter.tool.name), getter);
  for (const name of ['photoshop_create_document', 'photoshop_close_document'])
    assert.equal(registry.get(name), documents.find(definition => definition.tool.name === name));
  assert.equal(registry.list().length, 3);
  for (const definition of advanced) if (definition !== getter)
    assert.equal(registry.has(definition.tool.name), false);
  const result = await registry.get(getter.tool.name).handler({});
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), context);
  const missing = new ToolRegistry();
  assert.throws(() => registerNoRawDocumentTools(missing, connection, {
    ...factories, createAdvancedTools: () => advanced.filter(definition => definition !== getter),
  }), /NO_RAW_DOCUMENT_TOOL_DEFINITIONS_REQUIRED/);
  assert.deepEqual(missing.list(), []);
  assert.equal(calls.length, 1);
});

test('default/help/readiness are preparation only and expose the exact runner dependency', async () => {
  const messages = [], original = console.log;
  console.log = value => messages.push(value);
  try { await main([]); await main(['--help']); await main(['--readiness']); }
  finally { console.log = original; }
  assert.match(messages[0], /Preparation only/); assert.match(messages[1], /no PNG export/);
  const prepared = JSON.parse(messages[2]); assert.deepEqual(prepared, readiness());
  assert.equal(prepared.status, 'PREPARED'); assert.equal(prepared.nativeValidated, false);
  assert.deepEqual(prepared.variants, ['gray', 'depth16']);
  assert.deepEqual(prepared.requiredPerCase, NO_RAW_REQUIREMENTS);
  assert.equal(EVIDENCE_PATH, '.tmp/selection-fill-native-no-raw-es3-gate-evidence');
  assert.equal(prepared.evidence, EVIDENCE_PATH + '/evidence.json');
  assert.equal(NO_RAW_GATE_PATH, prepared.evidence);
  assert.throws(() => requireNoRawGate(prepared), /NO_RAW_GATE_REQUIRED/);
  await assert.rejects(main(['--unexpected']), /Use --help/);
});
