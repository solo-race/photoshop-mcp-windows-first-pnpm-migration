import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  CASES, EVIDENCE_PATH, EXPORT_PATHS, bracketScript, channelMetadataScript, cleanupOwnedAfterFailure, compareRawShape, compareRGBA, compareState,
  expectedMask, expectedOpaque, historyBracket, main, observationScript, requireAbsent,
} from './helpers/selection-fill-full-observation-gate.mjs';
import { SOURCE_PATH, expectedRGBA } from './helpers/selection-fill-rgba-roundtrip-gate.mjs';

test('full64 raw masks reject inverted polarity, missing pixels and nonunit counts', () => {
  for (const shape of ['one', 'four']) {
    const raw = expectedMask(shape), counts = Array(64).fill(1);
    assert.deepEqual(raw.flatMap((value, index) => value === 255 ? [index] : []),
      shape === 'one' ? [26] : [9, 13, 42, 54]);
    compareRawShape(raw, counts, shape);
    assert.throws(() => compareRawShape(raw.map(value => 255 - value), counts, shape),
      /FULL64_RAW_MASK_GATE/);
    assert.throws(() => compareRawShape(raw.slice(1), counts, shape), /FULL64_RAW_MASK_GATE/);
    const badCounts = [...counts]; badCounts[63] = 2;
    assert.throws(() => compareRawShape(raw, badCounts, shape), /COUNT_ONE_GATE/);
  }
});

test('all256 RGBA includes hidden RGB and fixed write changes only selected (2,3)', () => {
  const producer = expectedRGBA();
  const png = { width: 8, height: 8, rgba: Buffer.from(producer) };
  compareRGBA(png, producer);
  assert.deepEqual([...png.rgba.subarray(4, 8)], [7, 8, 9, 0]);
  png.rgba[4] = 0;
  assert.throws(() => compareRGBA(png, producer), /FULL_RGBA_LITERAL_GATE/);
  const before = expectedOpaque(), after = expectedOpaque(true);
  assert.deepEqual(Array.from({ length: 64 }, (_, index) => index).filter(index =>
    !before.subarray(index * 4, index * 4 + 4).equals(after.subarray(index * 4, index * 4 + 4))), [26]);
  assert.deepEqual([...after.subarray(104, 108)], [11, 29, 53, 255]);
  compareRGBA({ width: 8, height: 8, rgba: after }, expectedOpaque(true));
  assert.throws(() => compareRGBA({ width: 8, height: 8, rgba: after }, before), /FULL_RGBA_LITERAL_GATE/);
});

test('restoration permits observer history only; alpha structure and mask identity must match', () => {
  const before = {
    state: { layers: [{ id: 7, visible: true }], allChannels: [{ index: 0, name: 'Red' }] },
    getter: { ok: true, channels: ['Red', 'Green', 'Blue'] },
    am: { channelName: 'Layer Mask', itemIndex: 4, count: 4 },
    selection: { present: true, bounds: [1, 1, 7, 7] }, history: { id: 8, count: 4 },
  };
  const restored = structuredClone(before); restored.history = { id: 10, count: 6 };
  compareState(before, restored);
  restored.state.allChannels.push({ index: 1, name: 'owned-alpha' });
  assert.throws(() => compareState(before, restored), /COMPLETE_STATE_RESTORE_GATE/);
  const sameStructure = structuredClone(restored);
  sameStructure.history.id++;
  compareState(restored, sameStructure);
  const wrongMask = structuredClone(before); wrongMask.am.itemIndex++;
  assert.throws(() => compareState(before, wrongMask), /COMPLETE_STATE_RESTORE_GATE/);
  const wrongLayer = structuredClone(before); wrongLayer.state.layers[0].visible = false;
  assert.throws(() => compareState(before, wrongLayer), /COMPLETE_STATE_RESTORE_GATE/);
});

test('invisible channel histogram is unavailable without reading; visible errors still propagate', () => {
  let invisibleReads = 0, visibleReads = 0;
  const histogram = Array.from({ length: 256 }, (_, index) => index);
  const invisible = {
    name: 'owned-alpha', kind: 'masked-area', opacity: 50,
    color: { rgb: { red: 1, green: 2, blue: 3 } },
    get visible() { return false; },
    set visible(value) { throw new Error('SOURCE_VISIBILITY_MUST_NOT_CHANGE'); },
    get histogram() { invisibleReads++; throw new Error('INVISIBLE_HISTOGRAM_MUST_NOT_READ'); },
  };
  const visible = {
    name: 'Red', kind: 'component', visible: true,
    get histogram() { visibleReads++; return histogram; },
  };
  const script = channelMetadataScript() + '\nchannels;';
  const result = runInNewContext(script, {
    d: { channels: [visible, invisible] }, channels: [], ChannelType: { COMPONENT: 'component' },
  });
  assert.equal(invisibleReads, 0); assert.equal(visibleReads, 1);
  assert.equal(invisible.visible, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { index: 0, name: 'Red', kind: 'component', visible: true, histogram,
      histogramAvailability: { available: true, reason: null } },
    { index: 1, name: 'owned-alpha', kind: 'masked-area', visible: false, histogram: null,
      histogramAvailability: { available: false, reason: 'channel-not-visible' },
      opacity: 50, color: { r: 1, g: 2, b: 3 } },
  ]);
  const before = { state: { allChannels: JSON.parse(JSON.stringify(result)) } };
  const after = structuredClone(before);
  compareState(before, after);
  after.state.allChannels[1].histogramAvailability.available = true;
  assert.throws(() => compareState(before, after), /COMPLETE_STATE_RESTORE_GATE/);
  const failure = new Error('VISIBLE_HISTOGRAM_STOP');
  assert.throws(() => runInNewContext(script, {
    d: { channels: [{ name: 'Red', kind: 'component', visible: true,
      get histogram() { throw failure; } }] }, channels: [], ChannelType: { COMPONENT: 'component' },
  }), error => error === failure);
});

test('one synchronous JSX bracket contains only read/read or read/fill/read and stops on failure', () => {
  const baseline = {
    history: { id: 8, count: 4 }, active: { document_id: 3, layer_id: 7 },
    selection: { present: true, bounds: [2, 3, 3, 4] },
    state: { document: { id: 3 }, allChannels: [{ name: 'Red', histogram: [64, 0] }] },
  };
  const changedHistory = structuredClone(baseline); changedHistory.history.id++;
  const written = structuredClone(changedHistory); written.state.allChannels[0].histogram = [63, 1];
  historyBracket(baseline, structuredClone(baseline));
  assert.throws(() => historyBracket(baseline, changedHistory), /PURE_READ_STABILITY_GATE/);
  assert.equal(historyBracket(baseline, written, true).boundary, 'single-synchronous-executeScript');
  const changedTarget = structuredClone(written); changedTarget.active.layer_id++;
  assert.throws(() => historyBracket(baseline, changedTarget, true), /WRITE_TARGET_SELECTION_ACTIVE_GATE/);
  // Execute only the generated synchronous bracket tail, without mocking a run.
  for (const write of [false, true]) {
    const script = bracketScript(3, 7, 'rgb', write);
    const tail = script.slice(script.indexOf('// Single synchronous operation-frame bracket.'));
    const calls = []; let readIndex = 0, failFill = false;
    const environment = {
      snapshot() { calls.push('read'); return readIndex++ && write ? written : baseline; },
      SolidColor: function () { this.rgb = {}; }, ColorBlendMode: { NORMAL: 'normal' },
      app: { activeDocument: { selection: { fill(color, mode, opacity, preserveTransparency) {
        calls.push('fill');
        assert.deepEqual([color.rgb.red, color.rgb.green, color.rgb.blue, mode, opacity, preserveTransparency],
          [11, 29, 53, 'normal', 100, false]);
        if (failFill) throw new Error('FILL_STOP');
      } } } },
    };
    assert.doesNotMatch(tail, /executeAction|executeScript|withScope|inspect|export|activeChannels\s*=|selection\.select/);
    const result = runInNewContext('(function(){' + tail + '})()', environment);
    historyBracket(result.before, result.after, write);
    assert.deepEqual(calls, write ? ['read', 'fill', 'read'] : ['read', 'read']);
    if (write) {
      calls.length = 0; readIndex = 0; failFill = true;
      assert.throws(() => runInNewContext('(function(){' + tail + '})()', environment), /FILL_STOP/);
      assert.deepEqual(calls, ['read', 'fill']);
    }
  }
});

test('first owned cleanup failure returns STOP before later source, alpha or target actions', () => {
  // Execute only the generated cleanup block; no full-run or Photoshop mock framework.
  const script = observationScript(3, 7, 'rgb', 1);
  const marker = '// Sequential owned cleanup.';
  const start = script.indexOf(marker), end = script.indexOf('\nif(problem)return', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const environment = {
    copy: { close() { calls.push('copy.close'); throw new Error('CLOSE_STOP'); } }, copyId: 9,
    d: { id: 3 }, temporary: { remove() { calls.push('alpha.remove'); } },
    app: { set activeDocument(value) { calls.push('source.activate'); } },
    SaveOptions: { DONOTSAVECHANGES: 0 }, phase: '', cleanup: [], problem: null,
    channelName: 'owned-alpha', sameStructureBefore: {},
    snapshot() { calls.push('snapshot'); },
  };
  const result = runInNewContext('(function(){' + script.slice(start, end) + '})()', environment);
  assert.equal(result.ok, false); assert.equal(result.cleanupFailed, true);
  assert.equal(result.error.phase, 'cleanup.owned-copy');
  assert.equal(result.remaining.copy_id, 9);
  assert.deepEqual(calls, ['copy.close']);
});

test('known criterion or completed script failure closes owned IDs; unknown or cleanup failure stops', async () => {
  let localError;
  try { compareRawShape(Array(64).fill(0), Array(64).fill(1), 'one'); }
  catch (error) { localError = error; }
  assert.ok(localError instanceof assert.AssertionError);
  const finishedError = Object.assign(new Error('SCRIPT_REJECTED'), { completion: 'finished' });
  for (const error of [localError, finishedError]) {
    const owned = new Set([3, 9]), calls = [];
    const result = await cleanupOwnedAfterFailure({ owned, connection: { isFaulted: false },
      registry: {}, error, cleanupFailed: false,
      close: async doc => { calls.push(doc.id); owned.delete(doc.id); } });
    assert.deepEqual(calls, [3, 9]);
    assert.deepEqual(result, { status: 'completed', closed: [3, 9] });
    assert.equal(owned.size, 0);
  }
  for (const scenario of [
    { error: Object.assign(new Error('DISPATCH_UNKNOWN'), { completion: 'unknown' }), reason: 'unknown-dispatch' },
    { isFaulted: true, reason: 'connection-faulted' },
    { cleanupFailed: true, reason: 'cleanup-failed' },
  ]) {
    const owned = new Set([3, 9]), calls = [];
    const result = await cleanupOwnedAfterFailure({ owned,
      connection: { isFaulted: scenario.isFaulted ?? false }, registry: {},
      error: scenario.error ?? localError, cleanupFailed: scenario.cleanupFailed ?? false,
      close: async doc => { calls.push(doc.id); owned.delete(doc.id); } });
    assert.deepEqual(calls, []);
    assert.deepEqual([...owned], [3, 9]);
    assert.deepEqual(result, { status: 'skipped', reason: scenario.reason, closed: [] });
  }
  const owned = new Set([3, 9]), calls = [];
  const result = await cleanupOwnedAfterFailure({ owned, connection: { isFaulted: false },
    registry: {}, error: localError, cleanupFailed: false,
    close: async doc => { calls.push(doc.id); throw new Error('FIRST_CLOSE_FAILED'); } });
  assert.deepEqual(calls, [3]);
  assert.deepEqual([...owned], [3, 9]);
  assert.equal(result.status, 'STOP');
  assert.equal(result.failedId, 3);
  assert.match(result.error, /FIRST_CLOSE_FAILED/);
  assert.match(localError.message, /FULL64_RAW_MASK_GATE/);
});

test('default/help never execute; exact matrix and slots are bounded, existing source cannot be output', async () => {
  let executed = 0;
  for (const args of [[], ['--help'], ['-h']]) await main(args, async () => { executed++; });
  assert.equal(executed, 0);
  await assert.rejects(main(['--run', '--overwrite'], async () => { executed++; }), /Only --help or --run/);
  assert.equal(executed, 0);
  assert.equal(CASES.length, 5);
  assert.equal(CASES.filter(spec => spec.transparent && spec.target === 'mask').length, 0);
  assert.equal(EXPORT_PATHS.length, CASES.length * 4 + 1);
  assert.equal(new Set(EXPORT_PATHS).size, 21);
  assert.deepEqual(EXPORT_PATHS, Array.from({ length: 21 }, (_, index) =>
    `.tmp/selection-fill-native/${String(19 + index).padStart(3, '0')}.png`));
  assert.equal(EVIDENCE_PATH, '.tmp/selection-fill-native/full-observation-visible-channel-gate-evidence');
  assert.ok(!EXPORT_PATHS.includes(SOURCE_PATH));
  await assert.rejects(requireAbsent(new URL('./helpers/selection-fill-full-observation-gate.mjs', import.meta.url)),
    /FRESH_PATH_REQUIRED/);
});
