import assert from 'node:assert/strict';
import { NO_RAW_REQUIREMENTS, pureStateProjection } from './selection-fill-native-probe.mjs';
export const VARIANTS = Object.freeze(['gray', 'depth16']);
const MASKS = {
  one: [
    0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0, 0,0,255,0,0,0,0,0,
    0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
  ],
  four: [
    0,0,0,0,0,0,0,0, 0,255,0,0,0,255,0,0,
    0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0, 0,0,255,0,0,0,0,0,
    0,0,0,0,0,0,255,0, 0,0,0,0,0,0,0,0,
  ],
};
export const expectedShape = shape => {
  assert.ok(Object.hasOwn(MASKS, shape), 'KNOWN_SHAPE_REQUIRED');
  return [...MASKS[shape]];
};
export function validateShape(observation, shape) {
  assert.equal(observation?.ok, true, 'FULL_OBSERVER_PASS_REQUIRED');
  assert.equal(observation.cleanupFailed, undefined, 'FULL_OBSERVER_CLEANUP_GATE');
  assert.equal(observation.hasSelection, true, 'KNOWN_SELECTION_REQUIRED');
  assert.deepEqual(observation.shape, expectedShape(shape), 'FULL_64_RAW_SHAPE_GATE');
  assert.deepEqual(observation.counts, Array(64).fill(1), 'FULL_64_COUNT_GATE');
  assert.deepEqual(observation.cleanup, ['copy-closed', 'alpha-removed'], 'OWNED_COPY_ALPHA_CLEANUP_GATE');
}
export function validateNoRawState(snapshot, doc, shape) {
  const state = snapshot.state;
  assert.match(state.mode, doc.variant === 'gray' ? /GRAYSCALE/ : /RGB/, 'SOURCE_MODE_GATE');
  assert.match(state.depth, doc.variant === 'gray' ? /EIGHT/ : /SIXTEEN/, 'SOURCE_DEPTH_GATE');
  assert.equal(state.document.id, doc.id, 'SOURCE_DOCUMENT_GATE');
  assert.equal(state.document.width, 8); assert.equal(state.document.height, 8);
  assert.equal(state.document.saved, false, 'OWNED_UNSAVED_GATE');
  assert.deepEqual(snapshot.active, { document_id: doc.id, layer_id: doc.layer }, 'REAL_ACTIVE_TARGET_GATE');
  assert.equal(state.layers.length, 1, 'OWNED_LAYER_COUNT_GATE');
  assert.equal(state.layers[0].id, doc.layer, 'SOURCE_LAYER_GATE');
  assert.equal(state.target.method, 'getter', 'NO_RAW_GETTER_REQUIRED');
  const count = doc.variant === 'gray' ? 1 : 3;
  assert.equal(state.componentRoster.length, count, 'COMPONENT_ROSTER_GATE');
  assert.ok(state.componentRoster.every(row => row.component && /COMPONENT/.test(row.kind)), 'COMPONENT_KIND_GATE');
  assert.deepEqual(state.channels.map(row => row.name).sort(), state.componentRoster.map(row => row.name).sort(), 'COMPONENT_TARGET_GATE');
  assert.ok(state.channels.every(row => /COMPONENT/.test(row.kind)), 'COMPONENT_TARGET_KIND_GATE');
  assert.equal(state.allChannels.length, count, 'SOURCE_CHANNEL_COUNT_GATE');
  for (const channel of state.allChannels) {
    assert.equal(channel.histogram, null, 'ORIGINAL_PIXEL_BYTES_NOT_MEASURED');
    assert.deepEqual(channel.histogramAvailability, { available: false, reason: 'non-rgb-source-pixels-not-measured' },
      'ORIGINAL_HISTOGRAM_NOT_MEASURED');
  }
  assert.equal(snapshot.hasSelection, true, 'SOURCE_SELECTION_GATE');
  if (Object.hasOwn(snapshot, 'bounds'))
    assert.deepEqual(snapshot.bounds, shape === 'one' ? [2,3,3,4] : [1,1,7,7], 'SOURCE_SELECTION_BOUNDS_GATE');
  assert.ok(Number.isInteger(snapshot.history?.id) && Number.isInteger(snapshot.history?.count), 'HISTORY_REQUIRED');
}
export function validateRestoration(before, observation, after, doc, shape) {
  validateShape(observation, shape);
  for (const snapshot of [before, observation, after]) validateNoRawState(snapshot, doc, shape);
  assert.deepEqual(observation.state, before.state, 'OBSERVER_REPORTED_SOURCE_STATE_GATE');
  assert.deepEqual(observation.active, before.active, 'OBSERVER_REPORTED_ACTIVE_GATE');
  assert.deepEqual(pureStateProjection(after), pureStateProjection(before), 'SOURCE_STATE_RESTORED_GATE');
}
export function validateBracket(bracket, doc, shape, kind) {
  assert.ok(['stable', 'readonly', 'black-write'].includes(kind), 'BRACKET_KIND_REQUIRED');
  validateNoRawState(bracket.before, doc, shape);
  validateNoRawState(bracket.after, doc, shape);
  assert.deepEqual(pureStateProjection(bracket.after), pureStateProjection(bracket.before), 'BRACKET_SOURCE_STATE_GATE');
  if (kind === 'black-write') {
    assert.equal(shape, 'one', 'FIXED_ONE_PIXEL_WRITE_REQUIRED');
    assert.equal(bracket.result?.producer, 'black-selection-fill', 'ACTUAL_WRITE_PRODUCER_REQUIRED');
    assert.notEqual(bracket.after.history.id, bracket.before.history.id, 'ACTUAL_WRITE_HISTORY_CHANGE_GATE');
  } else {
    if (kind === 'readonly') assert.equal(bracket.result?.producer, 'readonly-noop', 'READONLY_ACTION_REQUIRED');
    assert.deepEqual(bracket.after, bracket.before, 'PURE_HISTORY_STATE_STABILITY_GATE');
  }
}
export function passEvidence(cases, remainingOwned) {
  assert.deepEqual(cases.map(row => row.variant).sort(), ['depth16', 'gray'], 'BOTH_NO_RAW_CASES_REQUIRED');
  assert.deepEqual(remainingOwned, [], 'OWNED_REMAINING_GATE');
  for (const row of cases) {
    for (const key of NO_RAW_REQUIREMENTS) assert.equal(row[key], true, 'NO_RAW_CRITERION:' + row.variant + ':' + key);
    assert.equal(row.closed, true, 'OWNED_CLOSE_REQUIRED:' + row.variant);
  }
  return { gate: 'selection-fill-native-no-raw', status: 'PASS', matrixAllowed: true, cases };
}
export function producerScript(doc, action) {
  assert.ok(VARIANTS.includes(doc.variant), 'NO_RAW_VARIANT_REQUIRED');
  assert.ok(['white-baseline', 'black-write', 'readonly'].includes(action), 'FIXED_PRODUCER_REQUIRED');
  const guard = 'var d=app.activeDocument;if(d.id!==' + doc.id + '||d.activeLayer.id!==' + doc.layer +
    "||d.width.as('px')!==8||d.height.as('px')!==8||d.layers.length!==1||d.mode!==DocumentMode." +
    (doc.variant === 'gray' ? 'GRAYSCALE' : 'RGB') + '||d.bitsPerChannel!==BitsPerChannelType.' +
    (doc.variant === 'gray' ? 'EIGHT' : 'SIXTEEN') + ")throw new Error('FIXED_PRODUCER_TARGET_GATE');";
  if (action === 'readonly') return guard + "return {producer:'readonly-noop'};";
  const color = action === 'white-baseline' ? 255 : 0;
  const selection = action === 'white-baseline' ? 'd.selection.selectAll();' :
    "var b=d.selection.bounds;if(b[0].as('px')!==2||b[1].as('px')!==3||b[2].as('px')!==3||b[3].as('px')!==4)throw new Error('FIXED_ONE_SELECTION_GATE');";
  return guard + selection + 'var c=new SolidColor();c.rgb.red=' + color + ';c.rgb.green=' + color +
    ';c.rgb.blue=' + color + ';d.selection.fill(c,ColorBlendMode.NORMAL,100,false);' +
    (action === 'white-baseline' ? 'd.selection.deselect();' : '') +
    'return {producer:' + JSON.stringify(action === 'white-baseline' ? 'white-full-baseline' : 'black-selection-fill') + '};';
}
export function registerNoRawDocumentTools(registry, connection, { createDocumentTools, createAdvancedTools }) {
  const documents = createDocumentTools(connection);
  const advanced = createAdvancedTools(connection, (name, args) => registry.execute(name, args));
  const definitions = ['photoshop_create_document', 'photoshop_close_document'].map(name =>
    documents.find(definition => definition.tool.name === name));
  definitions.push(advanced.find(definition => definition.tool.name === 'photoshop_get_active_context'));
  assert.ok(definitions.every(definition => definition && typeof definition.handler === 'function'),
    'NO_RAW_DOCUMENT_TOOL_DEFINITIONS_REQUIRED');
  for (const definition of definitions) registry.register(definition.tool.name, definition);
}
