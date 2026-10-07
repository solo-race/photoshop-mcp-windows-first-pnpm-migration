import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { nativeTargetScript, nativeObserverScript, nativeSnapshotEqualScript } from './helpers/selection-fill-native-tools.mjs';
import { channelMetadataScript, expectedMask } from './helpers/selection-fill-full-observation-gate.mjs';

test('getter-first preserves all/single/two/alpha exact channel objects without AM', () => {
  const components = [{ name: 'R', kind: 'COMPONENT' }, { name: 'G', kind: 'COMPONENT' }, { name: 'B', kind: 'COMPONENT' }];
  const alpha = { name: 'created-alpha', kind: 'MASKEDAREA' };
  for (const input of [components, [components[0]], components.slice(0, 2), [alpha]]) {
    let reads = 0, writes = 0;
    const d = { get activeChannels() { reads++; return input; }, set activeChannels(v) { writes++; } };
    const result = runInNewContext(nativeTargetScript(true) + '\nvar result=readTarget();restoreTarget(result);result;', {
      JSON: undefined, d, executeActionGet() { assert.fail('AM used for readable getter'); },
    });
    assert.equal(reads, 2); // capture and restore comparison, each exactly one read
    assert.equal(writes, 0);
    assert.equal(result.method, 'getter');
    assert.deepEqual([...result.objects], input);
    assert.deepEqual(JSON.parse(JSON.stringify(result.channels)), input);
  }
});

test('only explicit calibrated mask accepts throwing getter, retaining its original reason', () => {
  const failure = new Error('mask getter unavailable');
  const types = { BOOLEANTYPE: 'bool', STRINGTYPE: 'string', INTEGERTYPE: 'int', LISTTYPE: 'list' };
  const rows = { channelName: ['string', 'known-mask'], itemIndex: ['int', 4], count: ['int', 4],
    visible: ['bool', false], histogram: ['list', { count: 256, getInteger: i => i === 255 ? 64 : 0 }] };
  const mask = { hasKey: k => k === 'hasUserMask', getType: () => 'bool', getBoolean: () => true };
  const current = { hasKey: k => k in rows, getType: k => rows[k][0],
    getString: k => rows[k][1], getInteger: k => rows[k][1], getBoolean: k => rows[k][1], getList: k => rows[k][1] };
  let reads = 0, selects = 0, descriptors = 0;
  const d = { id: 3, activeLayer: { id: 9 }, mode: 'RGB', bitsPerChannel: 'EIGHT',
    get activeChannels() { reads++; throw failure; } };
  class Reference {
    putIdentifier() { this.layer = true; }
    putEnumerated() {}
  }
  const context = { JSON: undefined, d, app: { activeDocument: d }, DocumentMode: { RGB: 'RGB' },
    BitsPerChannelType: { EIGHT: 'EIGHT' }, DescValueType: types,
    charIDToTypeID: s => s, stringIDToTypeID: s => s, ActionReference: Reference,
    ActionDescriptor: class { putReference() {} }, DialogModes: { NO: 'NO' },
    executeActionGet: r => { descriptors++; return r.layer ? mask : current; },
    executeAction: (event) => { assert.equal(event, 'slct'); selects++; } };
  assert.throws(() => runInNewContext(nativeTargetScript(false) + '\nreadTarget();', context), e => e === failure);
  assert.equal(descriptors, 0);
  const target = runInNewContext(nativeTargetScript(true) + '\nvar target=readTarget();restoreTarget(target);target;', context);
  assert.equal(reads, 2);
  assert.equal(selects, 1);
  assert.equal(target.method, 'mask-AM');
  assert.equal(target.getterError.message, failure.message);
  assert.equal(target.am.histogram.length, 256);
  d.mode = 'GRAYSCALE';
  assert.throws(() => runInNewContext(nativeTargetScript(true) + '\nreadTarget();', context), e => e === failure);
});

test('invisible source metadata never reads histogram; visible failures stay fatal', () => {
  const failure = new Error('visible histogram failure');
  let calls = 0;
  const hidden = { name: 'hidden', kind: 'MASKEDAREA', visible: false, opacity: 50,
    color: { rgb: { red: 1, green: 2, blue: 3 } }, get histogram() { calls++; throw failure; } };
  const capture = () => runInNewContext('var channels=[];' + channelMetadataScript() + '\nchannels;', {
    d: { channels: [hidden] }, ChannelType: { COMPONENT: 'COMPONENT' },
  });
  const result = capture()[0];
  assert.equal(calls, 0);
  assert.equal(result.histogram, null);
  assert.equal(result.histogramAvailability.reason, 'channel-not-visible');
  assert.equal(hidden.visible, false);
  hidden.visible = true;
  assert.throws(capture, e => e === failure);
});

test('owned-copy measurement reads all64 raw MASKEDAREA pixels with count1 and no inversion', () => {
  const script = nativeObserverScript({ document_id: 3 });
  assert.match(script, /temporary.kind=ChannelType.MASKEDAREA/);
  assert.match(script, /if\(!a.visible\)a.visible=true/);
  assert.match(script, /copy.selection.deselect\(\)/);
  assert.doesNotMatch(script, /255-value|SELECTEDAREA/);
  const start = script.indexOf('  for(var y=0;y<8;y++)');
  const end = script.indexOf('\n }\n}catch(e)', start);
  for (const shape of ['one', 'four']) {
    const expected = expectedMask(shape);
    let pixel = -1;
    const context = { shape: [], counts: [], step: '', UnitValue: v => v, SelectionType: { REPLACE: 'replace' },
      copy: { selection: { select: corners => { pixel = corners[0][1] * 8 + corners[0][0]; } } },
      a: { get histogram() { const h = Array(256).fill(0); h[expected[pixel]] = 1; return h; } } };
    runInNewContext(script.slice(start, end), context);
    assert.deepEqual([...context.shape], expected);
    assert.deepEqual([...context.counts], Array(64).fill(1));
    context.a = { histogram: Array(256).fill(0) };
    assert.throws(() => runInNewContext(script.slice(start, end), context), /NATIVE_SHAPE_HISTOGRAM_GATE/);
  }
});

test('first owned-copy cleanup failure stops every following source action', () => {
  const script = nativeObserverScript({ document_id: 3 });
  const start = script.indexOf('try{\n if(copy){step=');
  const end = script.indexOf('\nif(problem)return', start);
  const calls = [];
  const result = runInNewContext('(function(){' + script.slice(start, end) + '})()', {
    copy: { close() { calls.push('copy-close'); throw new Error('close failed'); } }, copyId: 4,
    d: { id: 3 }, temporary: {}, channelName: 'owned-alpha', cleanup: [], problem: null,
    SaveOptions: { DONOTSAVECHANGES: false }, step: '',
    app: { set activeDocument(v) { calls.push('source-active'); } },
  });
  assert.deepEqual(calls, ['copy-close']);
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.remaining.copy_id, 4);
  assert.match(result.error.message, /close failed/);
});

test('ES3 snapshots restore different targets and reject source drift without JSON', () => {
  const rgb = [{ name: 'R', kind: 'COMPONENT' }, { name: 'G', kind: 'COMPONENT' }];
  const alpha = { name: 'temporary-alpha', kind: 'MASKEDAREA' };
  let active = rgb, writes = 0;
  const d = {
    get activeChannels() { return active; },
    set activeChannels(value) { writes++; active = value; },
  };
  const targetScript = nativeTargetScript(false) + `
var original=readTarget();restoreTarget(original);
d.activeChannels=[alpha];restoreTarget(original);
restoreTarget(original);original;`;
  runInNewContext(targetScript, { JSON: undefined, d, alpha });
  assert.equal(writes, 2); // one deliberate target change, one actual restoration
  assert.equal(active[0], rgb[0]);
  assert.equal(active[1], rgb[1]);

  const script = nativeObserverScript({ document_id: 3 });
  const tail = script.slice(script.indexOf("try{\n step='source.snapshot.after-cleanup'"));
  const before = { hasSelection: true, bounds: [1, 1, 7, 7],
    state: { saved: false, channels: [{ name: 'R', kind: 'COMPONENT' }],
      metadata: { visible: false, histogram: null, availability: { available: false } } },
    active: { document_id: 3, layer_id: 2 }, history: { id: 1 } };
  const compare = (after, sameBefore = null, sameAfter = null) => runInNewContext(
    '(function(){' + nativeSnapshotEqualScript() + tail + '})()', {
      JSON: undefined, before, snapshot: () => after, sameBefore, sameAfter,
      shape: [255], counts: [1], cleanup: ['copy-closed', 'alpha-removed'], step: '',
    });
  const after = structuredClone(before);
  after.history.id = 2;
  assert.equal(compare(after).ok, true);
  after.state.metadata.visible = true;
  const drift = compare(after);
  assert.equal(drift.ok, false);
  assert.equal(drift.cleanupFailed, false);
  assert.equal(drift.error.message, 'OBSERVER_SOURCE_STATE_RESTORE_GATE');
  const sameAfter = structuredClone(before);
  sameAfter.state.channels.push({ name: 'unexpected', kind: 'MASKEDAREA' });
  assert.equal(compare(structuredClone(before), before, sameAfter).error.message,
    'OBSERVER_SAME_STRUCTURE_GATE');
  assert.equal(runInNewContext(nativeSnapshotEqualScript() +
    '\nsnapshotEqual({a:null,b:[1,2]}, {b:[1,2],a:null});', { JSON: undefined }), true);
  assert.equal(runInNewContext(nativeSnapshotEqualScript() +
    '\nsnapshotEqual({a:null}, {a:null,b:undefined});', { JSON: undefined }), false);
});
