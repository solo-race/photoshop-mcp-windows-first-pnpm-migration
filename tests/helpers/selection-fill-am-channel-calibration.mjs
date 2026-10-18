import assert from 'node:assert/strict';

export async function discoverAndRestore({ documentId, layerId, read, setTarget, record }) {
  const observe = async label => {
    const actualOutput = await read(label);
    record('actual-output', { label, actualOutput }); // Preserve even a missing/wrong field before STOP.
    return selectedFields(actualOutput, documentId, layerId);
  };
  const set = async operation => {
    record('known-input', { operation, document_id: documentId, layer_id: layerId,
      ...(operation === 'alpha' ? { createdName: 'native-alpha' } : {}), identityVerified: false });
    const producerOutput = await setTarget(operation);
    record('producer-output', { operation, producerOutput, identityVerified: false });
  };
  const baseline = await observe('mask-baseline');
  // 4/4/false/256 is the isolated mask inventory evidence, not universal identity.
  assert.equal(baseline.itemIndex, 4, 'MASK_BASELINE_INDEX_GATE');
  assert.equal(baseline.count, 4, 'MASK_BASELINE_COUNT_GATE');
  assert.equal(baseline.visible, false, 'MASK_BASELINE_VISIBLE_GATE');
  assert.equal(baseline.histogramCount, 256, 'MASK_BASELINE_HISTOGRAM_METADATA_GATE');
  assert.ok(baseline.channelName.length, 'MASK_BASELINE_NAME_GATE'); // No localized mask name assumption.
  await set('rgb');
  await observe('known-rgb-before-alpha');
  await set('mask');
  assert.deepEqual(await observe('mask-restored-before-alpha'), baseline, 'MASK_RESTORE_SELECTED_FIELDS_GATE');
  record('mask-selected-fields-restored', { phase: 'before-alpha', fields: baseline, identityVerified: false });
  await set('alpha');
  const alpha = await observe('known-created-alpha');
  assert.equal(alpha.channelName, 'native-alpha', 'CREATED_ALPHA_NAME_GATE');
  // Other RGB/alpha values are recorded only; no first-read-derived expected.
  await set('mask');
  const postAlphaMask = await observe('mask-baseline-after-alpha');
  // Creating alpha changes the document structure; count/index are observations
  // until the next switch within this same structure, not the old 4/4 expected.
  assert.equal(postAlphaMask.channelName, baseline.channelName, 'POST_ALPHA_MASK_NAME_GATE');
  assert.equal(postAlphaMask.visible, false, 'POST_ALPHA_MASK_VISIBLE_GATE');
  assert.equal(postAlphaMask.histogramCount, 256, 'POST_ALPHA_MASK_HISTOGRAM_METADATA_GATE');
  await set('rgb');
  await observe('known-rgb-after-alpha');
  await set('mask');
  assert.deepEqual(await observe('mask-restored-after-alpha'), postAlphaMask, 'MASK_RESTORE_AFTER_ALPHA_SELECTED_FIELDS_GATE');
  record('mask-selected-fields-restored', { phase: 'after-alpha', fields: postAlphaMask, identityVerified: false });
}

export function selectedFields(actual, documentId, layerId) {
  assert.deepEqual(actual.active, { document_id: documentId, layer_id: layerId }, 'OWNED_ACTIVE_TARGET_CHANGED');
  assert.equal(actual.unscoped, true, 'UNSCOPED_ACTUAL_OUTPUT_GATE');
  const value = (key, kind, type) => {
    const field = actual.fields[key];
    if (!field?.present || field.kind !== kind || field.error || typeof field.value !== type)
      throw new Error('ACTUAL_CHANNEL_FIELD_GATE:' + key);
    return field.value;
  };
  const channelName = value('channelName', 'string', 'string');
  const itemIndex = value('itemIndex', 'integer', 'number');
  const count = value('count', 'integer', 'number');
  const visible = value('visible', 'boolean', 'boolean');
  const histogram = value('histogram', 'list', 'object');
  if (!Number.isInteger(itemIndex) || !Number.isInteger(count) || !Number.isInteger(histogram?.count)
    || histogram.count < 0 || histogram.valueNotRead !== true) throw new Error('ACTUAL_CHANNEL_METADATA_GATE');
  return { channelName, itemIndex, count, visible, histogramCount: histogram.count };
}

export async function readActualChannel({ connection, owned,
  documentId, layerId, PhotoshopAPIFactory, toExtendScriptValue }) {
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
  const document = (await connection.inspectDocuments()).find(d => d.id === documentId);
  if (!document) throw new Error('DOCUMENT_NOT_FOUND');
  return connection.withScope({}, async () => {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    return api.executeScript(actualChannelScript(toExtendScriptValue(documentId), toExtendScriptValue(layerId)), 15000);
  });
}

function fixtureGuard(documentId, layerId) {
  return `var d=app.activeDocument;
if(d.id!==${documentId}||d.activeLayer.id!==${layerId})throw new Error('OWNED_ACTIVE_TARGET_CHANGED');
var saved=false;try{d.fullName;saved=true;}catch(unsaved){}
if(saved||d.width.as('px')!==8||d.height.as('px')!==8||d.mode!==DocumentMode.RGB||d.bitsPerChannel!==BitsPerChannelType.EIGHT)throw new Error('OWNED_RGB8_FIXTURE_GATE');`;
}

export function targetScript(documentId, layerId, operation) {
  const actions = {
    rgb: 'd.activeChannels=d.componentChannels;',
    alpha: "var a=d.channels.add();a.name='native-alpha';d.activeChannels=[a];",
    mask: "var r=new ActionReference();r.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Chnl'),charIDToTypeID('Msk '));var s=new ActionDescriptor();s.putReference(charIDToTypeID('null'),r);executeAction(charIDToTypeID('slct'),s,DialogModes.NO);",
  };
  if (!Object.hasOwn(actions, operation)) throw new Error('UNKNOWN_FIXED_TARGET');
  return fixtureGuard(documentId, layerId) + '\n' + actions[operation]
    + '\nreturn {knownInputOnly:true,identityVerified:false};';
}

export function actualChannelScript(documentId, layerId) {
  return fixtureGuard(documentId, layerId) + `
var r=new ActionReference();r.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));
var desc=executeActionGet(r),fields={};
function field(key,expected,kind,get){
 var k=stringIDToTypeID(key),v={present:desc.hasKey(k)};fields[key]=v;
 if(!v.present)return;
 var t=desc.getType(k);v.type=String(t);
 if(t!==expected)return;
 v.kind=kind;
 try{v.value=get(k);}catch(e){v.error={message:String(e.message),number:e.number===undefined?null:e.number};}
}
field('channelName',DescValueType.STRINGTYPE,'string',function(k){return desc.getString(k);});
field('itemIndex',DescValueType.INTEGERTYPE,'integer',function(k){return desc.getInteger(k);});
field('count',DescValueType.INTEGERTYPE,'integer',function(k){return desc.getInteger(k);});
field('visible',DescValueType.BOOLEANTYPE,'boolean',function(k){return desc.getBoolean(k);});
field('histogram',DescValueType.LISTTYPE,'list',function(k){return {count:desc.getList(k).count,valueNotRead:true};});
return {active:{document_id:d.id,layer_id:d.activeLayer.id},fields:fields,descriptorCount:desc.count,
 unscoped:true,readOnly:true,inventoryOnly:true,identityVerified:false};`;
}
