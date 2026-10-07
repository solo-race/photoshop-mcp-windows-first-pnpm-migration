import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pureStateProjection, atomicBracket, mismatchLayerPairs, captureRejectedAction, verifyRejection, maskRejectionReason,
  requireNoRawGate, NO_RAW_REQUIREMENTS, readiness, COVERAGE, EXPORT_PATHS,
  PSD_PATHS, EVIDENCE_PATH, NO_RAW_GATE_PATH, main,
} from './helpers/selection-fill-native-probe.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function observation() {
  const channels = ['Red', 'Green', 'Blue'].map(name => ({ name, kind: 'ChannelType.COMPONENT' }));
  return {
    hasSelection: true, bounds: [2, 3, 3, 4],
    shape: Array.from({ length: 64 }, (_, i) => i === 26 ? 255 : 0), counts: Array(64).fill(1),
    active: { document_id: 7, layer_id: 70 }, history: { id: 100, count: 2 },
    state: {
      mode: 'DocumentMode.RGB', depth: 'BitsPerChannelType.EIGHT', quickMask: false,
      document: { id: 7, name: 'owned', width: 8, height: 8, resolution: 72,
        saved: true, pixelAspectRatio: 1 },
      channels, target: { method: 'getter', channels, getterError: null, am: null },
      allChannels: channels.map((channel, index) => ({ ...channel, index, visible: true,
        histogram: Array.from({ length: 256 }, (_, value) => value === 23 ? 64 : 0),
        histogramAvailability: { available: true, reason: null } })),
      components: channels.map(channel => channel.name),
      componentRoster: channels.map(channel => ({ ...channel, component: true })),
      layers: [{ id: 70, name: 'native-pixel', typename: 'ArtLayer', kind: 'LayerKind.NORMAL',
        visible: true, opacity: 100, fillOpacity: 100, blendMode: 'BlendMode.NORMAL', bounds: [0, 0, 8, 8],
        allLocked: false, pixelsLocked: false, transparentPixelsLocked: false,
        positionLocked: false, isBackgroundLayer: false,
        mask: { hasUserMask: { present: true, type: 'DescValueType.BOOLEANTYPE', value: false } } }],
    },
  };
}

test('equal initial document-local layer IDs are replaced before both foreign-layer directions', () => {
  const first = { id: 59, layer: 2, opaque: true }, second = { id: 70, layer: 2, opaque: false };
  assert.throws(() => mismatchLayerPairs(first, second, 2), /FIRST_LAYER_REPLACEMENT_GATE/);
  const replacedLayer = first.layer;
  first.layer = 3; // native_fixture adds the replacement and removes the original layer.
  const rosters = new Map([[first.id, [3]], [second.id, [2]]]);
  const pairs = mismatchLayerPairs(first, second, replacedLayer);
  assert.deepEqual(pairs, [[first, second], [second, first]]);
  for (const [target, foreign] of pairs) {
    assert.ok(rosters.get(target.id).includes(target.layer));
    assert.equal(rosters.get(target.id).includes(foreign.layer), false);
  }
  assert.deepEqual(second, { id: 70, layer: 2, opaque: false });
  assert.throws(() => mismatchLayerPairs(first, { ...second, layer: 3 }, replacedLayer), /FOREIGN_LAYER_IDS_GATE/);
});

test('strict and positive projections preserve selection and structural invariants', () => {
  const before = observation(), after = copy(before);
  after.history = { id: 101, count: 3 };
  assert.deepEqual(pureStateProjection(after), pureStateProjection(before));
  after.state.document.saved = false;
  after.state.allChannels[0].histogram[23]--;
  after.state.allChannels[0].histogram[11]++;
  assert.notDeepEqual(pureStateProjection(after), pureStateProjection(before));
  assert.deepEqual(pureStateProjection(after, 'positive'), pureStateProjection(before, 'positive'));
  assert.equal(before.state.document.saved, true);
  assert.equal(before.state.allChannels[0].histogram[23], 64);
  const changes = [
    value => { value.shape[26] = 0; }, value => { value.counts[26] = 2; },
    value => { value.bounds[2] = 4; }, value => { value.hasSelection = false; },
    value => { value.active.layer_id++; }, value => { value.state.document.width++; },
    value => { value.state.layers[0].mask.hasUserMask.value = true; },
    value => { value.state.layers[0].pixelsLocked = true; },
    value => { value.state.allChannels[0].visible = false; },
    value => { value.state.allChannels[0].histogramAvailability.available = false; },
    value => { value.state.target.channels[0].kind = 'ChannelType.MASKEDAREA'; },
  ];
  for (const change of changes) {
    const changed = copy(after); change(changed);
    assert.notDeepEqual(pureStateProjection(changed, 'positive'), pureStateProjection(before, 'positive'));
  }
  assert.throws(() => pureStateProjection(before, 'unknown'), /UNKNOWN_PROJECTION/);
});

test('PSD projection allows reopened identities and selection changes while retaining semantic state', () => {
  const before = observation(), reopened = copy(before);
  Object.assign(reopened.state.document, { id: 8, name: 'case-0.psd', saved: false });
  reopened.state.layers[0].id = 80;
  reopened.active = { document_id: 8, layer_id: 80 };
  reopened.hasSelection = false; reopened.bounds = null; reopened.shape = []; reopened.counts = [];
  reopened.state.allChannels[0].histogram[23] = 0;
  assert.deepEqual(pureStateProjection(reopened, 'psd'), pureStateProjection(before, 'psd'));
  for (const change of [
    value => { value.state.mode = 'DocumentMode.GRAYSCALE'; },
    value => { value.state.depth = 'BitsPerChannelType.SIXTEEN'; },
    value => { value.state.document.height++; },
    value => { value.state.layers[0].opacity = 90; },
    value => { value.state.layers[0].name = 'other'; },
    value => { value.state.layers[0].mask.hasUserMask.value = true; },
    value => { value.state.allChannels[0].name = 'other'; },
    value => { value.state.allChannels[0].histogramAvailability.available = false; },
  ]) {
    const changed = copy(reopened); change(changed);
    assert.notDeepEqual(pureStateProjection(changed, 'psd'), pureStateProjection(before, 'psd'));
  }
});

test('atomic bracket reads around exactly one action and stops immediately on an unsafe thrown action', async () => {
  const calls = [], first = observation(); let reads = 0;
  const read = async () => { calls.push('pure'); reads++; return copy(first); };
  const stable = await atomicBracket(read);
  assert.deepEqual(calls, ['pure', 'pure']); assert.deepEqual(stable.before, stable.after);
  assert.equal(stable.result, null);
  calls.length = 0;
  const result = { isError: true };
  const rejected = await atomicBracket(read, async () => { calls.push('action'); return result; });
  assert.deepEqual(calls, ['pure', 'action', 'pure']); assert.equal(rejected.result, result);
  const failure = Object.assign(new Error('unknown dispatch'), { completion: 'unknown' });
  calls.length = 0;
  await assert.rejects(atomicBracket(read, async () => { calls.push('action'); throw failure; }), error => error === failure);
  assert.deepEqual(calls, ['pure', 'action']); assert.equal(reads, 5);
  calls.length = 0;
  await assert.rejects(atomicBracket(async () => { calls.push('pure'); throw failure; },
    async () => { calls.push('action'); }), error => error === failure);
  assert.deepEqual(calls, ['pure']);
});

test('rejection matching preserves the corroborated mask getter cause and rejects unexpected reasons', () => {
  const observed = observation();
  observed.state.target = { method: 'mask-AM', getterError: {
    phase: 'activeChannels.getter', message: 'calibrated native getter failure', number: 8453 }, am: {} };
  const reason = maskRejectionReason(observed);
  assert.equal(reason, 'Fill cannot verify RGB target: calibrated native getter failure');
  const sanitized = 'PHOTOSHOP_OPERATION_FAILED: inspect the selected document locally; no automatic retry or recovery performed.';
  const result = { isError: true, content: [{ type: 'text', text: sanitized }] };
  const captured = { result, didThrow: false, scriptErrors: [reason] };
  assert.deepEqual(verifyRejection(captured, { script: reason }, 'mask'), { rejection: sanitized, originalReason: reason });
  assert.throws(() => verifyRejection(captured, { script: 'Fill requires all RGB component channels' }, 'mask'), /UNEXPECTED_REJECTION_REASON/);
  assert.throws(() => verifyRejection({ ...captured, scriptErrors: [reason, reason] }, { script: reason }, 'mask'), /MISSING_OR_EXTRA_SCRIPT_FAILURE/);
  assert.throws(() => verifyRejection({ ...captured, result: { ...result, content: [{ type: 'text', text: 'other' }] } }, { script: reason }, 'mask'), /UNEXPECTED_REJECTION_CODE/);
  const error = new Error('INVALID_ARGUMENT');
  assert.deepEqual(verifyRejection({ error, didThrow: true, scriptErrors: [] }, { throw: error.message }, 'static'),
    { rejection: error.message, originalReason: undefined });
  assert.throws(() => verifyRejection({ error, didThrow: true, scriptErrors: [] }, { throw: 'other' }, 'static'), thrown => thrown === error);
  const handler = { ...captured, scriptErrors: [], handlerResult: { isError: true, content: [{ type: 'text', text: 'GRANT_DENIED' }] } };
  assert.equal(verifyRejection(handler, { handler: 'GRANT_DENIED' }, 'grant').originalReason, 'GRANT_DENIED');
  observed.state.target.method = 'getter';
  assert.throws(() => maskRejectionReason(observed), /MASK_GETTER_CAUSE_GATE/);
});

test('real API and fill handler capture completed envelopes once and stop on unknown dispatch', async () => {
  const [{ PhotoshopAPIFactory }, { createLayerTools }] = await Promise.all([
    import('../dist/api/photoshop-api.js'), import('../dist/tools/layer-tools.js'),
  ]);
  const reason = 'Fill requires an editable RGB8 pixel layer';
  const envelope = { ok: false, error: { message: reason } }, calls = [];
  let failure;
  const connection = {
    isFaulted: false,
    getPhotoshopInfo: () => ({ version: '26.0' }),
    executeScript: async script => {
      calls.push('script'); assert.match(script, /__psEncode/);
      if (failure) throw failure;
      return envelope;
    },
  };
  const api = await new PhotoshopAPIFactory(connection).createAPI();
  assert.equal(api.getAPIType(), 'ExtendScript');
  await assert.rejects(api.executeScript('return null;'), error => error.message === reason);
  calls.length = 0;
  const definition = createLayerTools(connection).find(row => row.tool.name === 'photoshop_fill_layer');
  const execute = connection.executeScript, handler = definition.handler;
  const args = { scope: 'selection', red: 11, green: 29, blue: 53 };
  const sanitized = { isError: true, content: [{ type: 'text', text:
    'PHOTOSHOP_OPERATION_FAILED: inspect the selected document locally; no automatic retry or recovery performed.' }] };
  const invoke = async parameters => {
    const result = await definition.handler(parameters);
    assert.equal(result.isError, true);
    return sanitized;
  };
  const captured = await captureRejectedAction(connection, definition, () => invoke(args));
  assert.deepEqual(calls, ['script']); assert.deepEqual(captured.scriptErrors, [reason]);
  assert.equal(captured.result, sanitized); assert.equal(captured.didThrow, false);
  assert.equal(captured.handlerResult.content[0].text, 'Error filling layer: ' + reason);
  assert.equal(verifyRejection(captured, { script: reason }, 'envelope').originalReason, reason);
  assert.throws(() => verifyRejection(captured, { script: 'other' }, 'envelope'), /UNEXPECTED_REJECTION_REASON/);
  assert.equal(connection.executeScript, execute); assert.equal(definition.handler, handler);

  failure = Object.assign(new Error(reason), { completion: 'finished' }); calls.length = 0;
  const completedThrow = await captureRejectedAction(connection, definition, () => invoke(args));
  assert.deepEqual(calls, ['script']); assert.deepEqual(completedThrow.scriptErrors, [reason]);
  assert.equal(verifyRejection(completedThrow, { script: reason }, 'finished').originalReason, reason);
  failure = undefined; calls.length = 0;
  const invalid = await captureRejectedAction(connection, definition, () => invoke({ ...args, scope: 'invalid' }));
  assert.deepEqual(calls, []); assert.deepEqual(invalid.scriptErrors, []);
  assert.equal(verifyRejection(invalid, { handler: 'Error filling layer: Fill scope must be selection or layer' }, 'static-handler').originalReason,
    'Error filling layer: Fill scope must be selection or layer');

  failure = Object.assign(new Error('unknown dispatch'), { completion: 'unknown' }); calls.length = 0;
  await assert.rejects(atomicBracket(async () => { calls.push('pure'); return observation(); },
    () => captureRejectedAction(connection, definition, () => invoke(args))), error => error === failure);
  assert.deepEqual(calls, ['pure', 'script']);
  assert.equal(connection.executeScript, execute); assert.equal(definition.handler, handler);
});

test('Gray and 16-bit each require an independent complete no-raw PASS', () => {
  const gate = { status: 'PASS', gate: 'selection-fill-native-no-raw', matrixAllowed: true,
    cases: ['gray', 'depth16'].map(variant => ({ variant,
      ...Object.fromEntries(NO_RAW_REQUIREMENTS.map(key => [key, true])) })) };
  assert.equal(requireNoRawGate(gate), gate);
  for (const variant of ['gray', 'depth16']) for (const key of NO_RAW_REQUIREMENTS) {
    const incomplete = copy(gate); incomplete.cases.find(row => row.variant === variant)[key] = false;
    assert.throws(() => requireNoRawGate(incomplete), /NO_RAW_GATE_CRITERION/);
  }
  assert.throws(() => requireNoRawGate(undefined), /NO_RAW_GATE_REQUIRED/);
  assert.throws(() => requireNoRawGate({ ...gate, status: 'PREPARED' }), /NO_RAW_GATE_REQUIRED/);
  assert.throws(() => requireNoRawGate({ ...gate, matrixAllowed: false }), /NO_RAW_GATE_REQUIRED/);
  assert.throws(() => requireNoRawGate({ ...gate, cases: [gate.cases[0]] }), /NO_RAW_GATE_CASES/);
});

test('default, help and readiness expose bounded coverage and new paths without executing the matrix', async () => {
  assert.deepEqual(COVERAGE, { sequentialPoints: 8, selectionFills: 4, psdReopens: 4,
    rejections: 22, legalLayerFill: 1, canvasEdgeSelection: 1, rgbObserverChecks: 8,
    alphaObserverChecks: 2, noRawObserverChecks: 4 });
  assert.deepEqual(EXPORT_PATHS, Array.from({ length: 105 }, (_, i) =>
    '.tmp/selection-fill-native/' + String(i + 40).padStart(3, '0') + '.png'));
  assert.equal(new Set(EXPORT_PATHS).size, 105);
  assert.deepEqual(PSD_PATHS, Array.from({ length: 4 }, (_, i) => '.tmp/selection-fill-native/case-' + i + '.psd'));
  assert.equal(EVIDENCE_PATH, '.tmp/selection-fill-native/matrix-prepared-observer-evidence');
  assert.equal(NO_RAW_GATE_PATH, '.tmp/selection-fill-native-no-raw-es3-gate-evidence/evidence.json');
  const messages = [], log = console.log;
  console.log = message => messages.push(message);
  try { await main([]); await main(['--help']); await main(['--readiness']); }
  finally { console.log = log; }
  assert.equal(messages.length, 3); assert.match(messages[0], /Preparation only/);
  assert.match(messages[1], /PNG040\.\.144/);
  const prepared = JSON.parse(messages[2]);
  assert.deepEqual(prepared, readiness()); assert.equal(prepared.nativeValidated, false);
  assert.equal(prepared.status, 'PREPARED'); assert.equal(prepared.exports.count, 105);
  assert.equal(prepared.dependency, NO_RAW_GATE_PATH);
});
