import assert from 'node:assert/strict';
import { selectedFields, actualChannelScript } from './selection-fill-am-channel-calibration.mjs';

export class GetterBlocked extends Error {
  constructor(label, originalError) {
    super('ACTUAL_GETTER_BLOCKED:' + label);
    this.originalError = originalError;
  }
}

function channelSet(channels) {
  assert.ok(Array.isArray(channels) && channels.length > 0, 'TYPED_CHANNEL_SET_GATE');
  const values = channels.map(channel => {
    assert.ok(typeof channel.name === 'string' && channel.name.length
      && typeof channel.kind === 'string' && channel.kind.length, 'TYPED_CHANNEL_METADATA_GATE');
    return JSON.stringify([channel.name, channel.kind]);
  });
  assert.equal(new Set(values).size, values.length, 'AMBIGUOUS_CHANNEL_SET_GATE');
  return values.sort();
}

export function validateGetter(getter, expected, label) {
  assert.ok(getter && typeof getter.ok === 'boolean', 'ACTUAL_GETTER_MISSING');
  if (!getter.ok) throw new GetterBlocked(label, getter.error);
  assert.ok(Number.isInteger(getter.length) && Array.isArray(getter.channels)
    && getter.length === getter.channels.length, 'ACTUAL_GETTER_LENGTH_GATE');
  assert.deepEqual(channelSet(getter.channels), channelSet(expected), 'ACTUAL_TARGET_SET_MISMATCH:' + label);
}

export async function verifyKnownTargets({ documentId, layerId, roster, read, setTarget, record }) {
  assert.ok(Array.isArray(roster) && roster.length === 3
    && roster.every(channel => channel.component === true), 'INDEPENDENT_COMPONENT_ROSTER_GATE');
  channelSet(roster);
  record('independent-component-roster', { roster });
  const observe = async (label, getter = false, requireAM = !getter) => {
    const actualOutput = await read(label, getter);
    record('actual-output', { label, actualOutput });
    let fields;
    if (requireAM) {
      assert.equal(actualOutput.am?.ok, true, 'MASK_AM_READ_GATE');
      fields = selectedFields(actualOutput.am.value, documentId, layerId);
    }
    return { fields, getter: actualOutput.getter };
  };
  const baseline = (await observe('mask-baseline', true, true)).fields;
  // Mask getter is diagnostic only; its original failure is retained, not generalized.
  assert.equal(baseline.itemIndex, 4, 'MASK_BASELINE_INDEX_GATE');
  assert.equal(baseline.count, 4, 'MASK_BASELINE_COUNT_GATE');
  assert.equal(baseline.visible, false, 'MASK_BASELINE_VISIBLE_GATE');
  assert.equal(baseline.histogramCount, 256, 'MASK_BASELINE_HISTOGRAM_GATE');
  assert.ok(baseline.channelName.length, 'MASK_BASELINE_NAME_GATE');
  for (const [operation, expected] of [
    ['all', roster], ['single', [roster[0]]], ['two', [roster[0], roster[1]]],
  ]) {
    await setTarget(operation);
    const actual = await observe(operation, true);
    validateGetter(actual.getter, expected, operation);
    record('target-set-verified', { operation, expected, scope: 'owned-fixture-only' });
    await setTarget('mask');
    assert.deepEqual((await observe('mask-restored-' + operation)).fields, baseline, 'MASK_RESTORE_SELECTED_FIELDS_GATE');
  }
  const producer = await setTarget('alpha');
  const expectedAlpha = producer.createdAlpha;
  assert.equal(expectedAlpha?.name, 'native-alpha', 'CREATED_ALPHA_NAME_GATE');
  channelSet([expectedAlpha]);
  assert.ok(!roster.some(channel => channel.kind === expectedAlpha.kind), 'CREATED_ALPHA_COMPONENT_CONFUSION_GATE');
  record('independent-created-alpha', { expectedAlpha });
  const alpha = await observe('alpha', true);
  validateGetter(alpha.getter, [expectedAlpha], 'alpha');
  record('target-set-verified', { operation: 'alpha', expected: [expectedAlpha], scope: 'owned-fixture-only' });
  await setTarget('mask');
  const postAlpha = (await observe('mask-baseline-after-alpha')).fields;
  assert.equal(postAlpha.channelName, baseline.channelName, 'POST_ALPHA_MASK_NAME_GATE');
  assert.equal(postAlpha.visible, false, 'POST_ALPHA_MASK_VISIBLE_GATE');
  assert.equal(postAlpha.histogramCount, 256, 'POST_ALPHA_MASK_HISTOGRAM_GATE');
  await setTarget('all');
  await observe('all-after-alpha-am-only', false, false); // Parallel AM only; no second getter.
  await setTarget('mask');
  assert.deepEqual((await observe('mask-restored-after-alpha')).fields, postAlpha, 'POST_ALPHA_MASK_RESTORE_GATE');
  record('mask-selected-fields-restored', { fields: postAlpha, sameStructure: true });
  return { channelIdentityGatePassed: true, verifiedTargets: ['all', 'single', 'two', 'alpha'],
    identityVerified: false, observerRepairAllowed: false };
}

export async function readIdentity(options) {
  const { connection, owned, documentId, layerId,
    PhotoshopAPIFactory, toExtendScriptValue } = options;
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
  const document = (await connection.inspectDocuments()).find(d => d.id === documentId);
  if (!document) throw new Error('DOCUMENT_NOT_FOUND');
  return connection.withScope({}, async () => {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    return api.executeScript(identityReadScript(toExtendScriptValue(documentId),
      toExtendScriptValue(layerId), options.getter), 15000);
  });
}

function guard(documentId, layerId) {
  return `var d=app.activeDocument;
if(d.id!==${documentId}||d.activeLayer.id!==${layerId})throw new Error('OWNED_ACTIVE_TARGET_CHANGED');
var saved=false;try{d.fullName;saved=true;}catch(unsaved){}
if(saved||d.width.as('px')!==8||d.height.as('px')!==8||d.mode!==DocumentMode.RGB||d.bitsPerChannel!==BitsPerChannelType.EIGHT)throw new Error('OWNED_RGB8_FIXTURE_GATE');`;
}

export function producerScript(documentId, layerId, operation) {
  const actions = {
    roster: '',
    all: 'd.activeChannels=components;',
    single: 'd.activeChannels=[components[0]];',
    two: 'd.activeChannels=[components[0],components[1]];',
    alpha: "var a=d.channels.add();a.name='native-alpha';d.activeChannels=[a];if(a.kind===undefined||a.kind===null||a.kind===ChannelType.COMPONENT)throw new Error('CREATED_ALPHA_TYPE_GATE');result.createdAlpha={name:a.name,kind:String(a.kind)};",
    mask: "var r=new ActionReference();r.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Chnl'),charIDToTypeID('Msk '));var s=new ActionDescriptor();s.putReference(charIDToTypeID('null'),r);executeAction(charIDToTypeID('slct'),s,DialogModes.NO);",
  };
  if (!Object.hasOwn(actions, operation)) throw new Error('UNKNOWN_FIXED_TARGET');
  return guard(documentId, layerId) + `
var components=d.componentChannels,rows=[];
if(components.length!==3)throw new Error('COMPONENT_ROSTER_LENGTH_GATE');
for(var i=0;i<components.length;i++){
 var c=components[i];if(c.kind!==ChannelType.COMPONENT)throw new Error('COMPONENT_ROSTER_TYPE_GATE');
 rows.push({name:c.name,kind:String(c.kind),component:true});
}
var result={knownInputOnly:true,identityVerified:false,roster:rows};
` + actions[operation] + '\nreturn result;';
}

export function getterDiagnosticScript(documentId, layerId) {
  return guard(documentId, layerId) + `
var phase='activeChannels.getter';
try{
 var targets=d.activeChannels; // Exactly one getter access; no setter or retry.
 phase='activeChannels.length';var length=targets.length,channels=[];
 for(var i=0;i<length;i++){
  phase='activeChannels['+i+'].name';var name=targets[i].name;
  phase='activeChannels['+i+'].kind';var rawKind=targets[i].kind,kind=rawKind===undefined||rawKind===null?null:String(rawKind);
  channels.push({name:name,kind:kind});
 }
 return {ok:true,length:length,channels:channels};
}catch(e){return {ok:false,error:{message:String(e.message),number:e.number===undefined?null:e.number,phase:phase}};}`;
}

export function identityReadScript(documentId, layerId, getter = true) {
  // Ownership/fixture failures stay fatal. Only the parallel AM read is caught.
  return guard(documentId, layerId)
    + '\nvar getter=' + (getter ? '(function(){' + getterDiagnosticScript(documentId, layerId) + '})()' : 'null')
    + ';\nvar am;try{am={ok:true,value:(function(){' + actualChannelScript(documentId, layerId)
    + '})()};}catch(e){am={ok:false,error:{message:String(e.message),number:e.number===undefined?null:e.number,phase:"AM.current-channel"}};}'
    + '\nreturn {am:am,getter:getter};';
}
