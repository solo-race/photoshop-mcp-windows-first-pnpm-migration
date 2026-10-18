import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { actualChannelScript } from './selection-fill-am-channel-calibration.mjs';
import { getterDiagnosticScript } from './selection-fill-channel-identity-gate.mjs';
const MASKS = {
  one: [
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,255,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
  ],
  four: [
    0,0,0,0,0,0,0,0,
    0,255,0,0,0,255,0,0,
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,
    0,0,255,0,0,0,0,0,
    0,0,0,0,0,0,255,0,
    0,0,0,0,0,0,0,0,
  ],
};
export function expectedMask(shape) {
  assert.ok(Object.hasOwn(MASKS, shape), 'FIXED_SHAPE_REQUIRED');
  return [...MASKS[shape]];
}
export function expectedOpaque(afterWrite = false) {
  const bytes = Buffer.alloc(256);
  for (let i = 0; i < 64; i++) bytes.set([23,47,89,255], i * 4);
  // Independent known write input: only (2,3), never the whole canvas.
  if (afterWrite) bytes.set([11,29,53,255], 104);
  return bytes;
}
export function compareRGBA(actual, expected) {
  assert.equal(actual.width, 8, 'PNG_WIDTH_GATE');
  assert.equal(actual.height, 8, 'PNG_HEIGHT_GATE');
  assert.equal(actual.rgba.length, 256, 'PNG_FULL_RGBA_GATE');
  assert.deepEqual(actual.rgba, expected, 'FULL_RGBA_LITERAL_GATE');
}
export function compareRawShape(values, counts, shape) {
  assert.deepEqual(counts, Array(64).fill(1), 'EACH_PIXEL_HISTOGRAM_COUNT_ONE_GATE');
  assert.deepEqual(values, expectedMask(shape), 'FULL64_RAW_MASK_GATE');
}
export function compareState(before, after) {
  const { history: ignoredBefore, ...original } = before;
  const { history: ignoredAfter, ...restored } = after;
  assert.deepEqual(restored, original, 'COMPLETE_STATE_RESTORE_GATE');
}
export function historyBracket(before, after, write = false) {
  for (const snapshot of [before, after]) {
    assert.ok(Number.isInteger(snapshot.history?.id), 'HISTORY_ID_GATE');
    assert.ok(Number.isInteger(snapshot.history?.count), 'HISTORY_COUNT_GATE');
  }
  if (write) {
    assert.notEqual(after.history.id, before.history.id, 'REAL_WRITE_HISTORY_CHANGE_GATE');
    const { allChannels: bChannels, ...bState } = before.state;
    const { allChannels: aChannels, ...aState } = after.state;
    assert.deepEqual(aState, bState, 'WRITE_NONPIXEL_STATE_GATE');
    // Only channel histograms may change with this fixed pixel write.
    assert.deepEqual(aChannels.map(({ histogram, ...c }) => c),
      bChannels.map(({ histogram, ...c }) => c), 'WRITE_CHANNEL_METADATA_GATE');
    const { state: ignoredBState, history: ignoredBHistory, ...bOther } = before;
    const { state: ignoredAState, history: ignoredAHistory, ...aOther } = after;
    assert.deepEqual(aOther, bOther, 'WRITE_TARGET_SELECTION_ACTIVE_GATE');
  } else {
    assert.deepEqual(after, before, 'PURE_READ_STABILITY_GATE');
  }
  return { before, after, action: write ? 'fixed-one-pixel-fill' : 'none',
    boundary: 'single-synchronous-executeScript' };
}
export async function requireAbsent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('FRESH_PATH_REQUIRED:' + path);
}
export async function cleanupOwnedAfterFailure({ owned, connection, registry, close, error, cleanupFailed }) {
  const closed = [];
  if (cleanupFailed) return { status: 'skipped', reason: 'cleanup-failed', closed };
  if (error?.completion === 'unknown') return { status: 'skipped', reason: 'unknown-dispatch', closed };
  if (!connection || !registry || !close) return { status: 'skipped', reason: 'not-initialized', closed };
  if (connection.isFaulted) return { status: 'skipped', reason: 'connection-faulted', closed };
  for (const id of [...owned]) {
    if (connection.isFaulted) return { status: 'stopped', reason: 'connection-faulted', closed };
    try { await close({ id }); closed.push(id); }
    catch (cleanupError) {
      return { status: 'STOP', closed, failedId: id, error: String(cleanupError) };
    }
  }
  return { status: 'completed', closed };
}

function guard(documentId, layerId) {
  return `var d=app.activeDocument;
if(d.id!==${documentId}||d.activeLayer.id!==${layerId})throw new Error('OWNED_ACTIVE_TARGET_CHANGED');
var savedPath=false;try{d.fullName;savedPath=true;}catch(unsaved){}
if(savedPath||d.width.as('px')!==8||d.height.as('px')!==8||d.mode!==DocumentMode.RGB||d.bitsPerChannel!==BitsPerChannelType.EIGHT||d.layers.length!==1)throw new Error('OWNED_UNSAVED_RGB8_GATE');`;
}
function restoreTarget(target) {
  assert.ok(['rgb', 'mask'].includes(target), 'FIXED_TARGET_REQUIRED');
  return target === 'rgb' ? 'd.activeChannels=d.componentChannels;' : `
var mr=new ActionReference();mr.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Chnl'),charIDToTypeID('Msk '));
var md=new ActionDescriptor();md.putReference(charIDToTypeID('null'),mr);executeAction(charIDToTypeID('slct'),md,DialogModes.NO);`;
}
export function channelMetadataScript() {
  return `for(var i=0;i<d.channels.length;i++){
 var c=d.channels[i],visible=c.visible;
 var metadata={index:i,name:c.name,kind:String(c.kind),visible:visible,histogram:null,
 histogramAvailability:{available:visible,reason:visible?null:'channel-not-visible'}};
 if(visible){var h=c.histogram,values=[];for(var j=0;j<h.length;j++)values.push(h[j]);metadata.histogram=values;}
 if(c.kind!==ChannelType.COMPONENT){metadata.opacity=c.opacity;var rgb=c.color.rgb;metadata.color={r:rgb.red,g:rgb.green,b:rgb.blue};}
 channels.push(metadata);
}`;
}
function snapshotFunction(documentId, layerId, target) {
  return `function snapshot(){
${guard(documentId, layerId)}
var ref=new ActionReference();ref.putIdentifier(charIDToTypeID('Dcmn'),d.id);
var has=executeActionGet(ref).hasKey(stringIDToTypeID('selection')),bounds=null;
if(has){bounds=[];var b=d.selection.bounds;for(var i=0;i<4;i++)bounds.push(b[i].as('px'));}
var layers=[],channels=[],components=[];
for(var i=0;i<d.layers.length;i++){
 var l=d.layers[i],lb=l.bounds,px=[];for(var j=0;j<4;j++)px.push(lb[j].as('px'));
 var lr=new ActionReference();lr.putIdentifier(charIDToTypeID('Lyr '),l.id);var ld=executeActionGet(lr),mask={};
 var keys=['hasUserMask','userMaskEnabled','userMaskLinked','userMaskDensity','userMaskFeather'];
 for(var j=0;j<keys.length;j++){
  var k=stringIDToTypeID(keys[j]),v={present:ld.hasKey(k)};mask[keys[j]]=v;
  if(v.present){var t=ld.getType(k);v.type=String(t);
   if(t===DescValueType.BOOLEANTYPE)v.value=ld.getBoolean(k);
   else if(t===DescValueType.INTEGERTYPE)v.value=ld.getInteger(k);
   else if(t===DescValueType.DOUBLETYPE)v.value=ld.getDouble(k);
   else if(t===DescValueType.UNITDOUBLE)v.value=ld.getUnitDoubleValue(k);
   else throw new Error('MASK_METADATA_TYPE_GATE');}
 }
 layers.push({id:l.id,name:l.name,typename:l.typename,kind:String(l.kind),visible:l.visible,
 opacity:l.opacity,fillOpacity:l.fillOpacity,blendMode:String(l.blendMode),bounds:px,
 allLocked:l.allLocked,pixelsLocked:l.pixelsLocked,transparentPixelsLocked:l.transparentPixelsLocked,
 positionLocked:l.positionLocked,isBackgroundLayer:l.isBackgroundLayer,mask:mask});
}
${channelMetadataScript()}
for(var i=0;i<d.componentChannels.length;i++){var c=d.componentChannels[i];components.push({name:c.name,kind:String(c.kind),component:c.kind===ChannelType.COMPONENT});}
var getter=(function(){${getterDiagnosticScript(documentId, layerId)}})(),am=null,maskHistogram=null;
${target === 'mask' ? `am=(function(){${actualChannelScript(documentId, layerId)}})();
var ar=new ActionReference();ar.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));
var ad=executeActionGet(ar),ak=stringIDToTypeID('histogram');
if(!ad.hasKey(ak)||ad.getType(ak)!==DescValueType.LISTTYPE)throw new Error('MASK_HISTOGRAM_GATE');
var ah=ad.getList(ak);maskHistogram=[];for(var i=0;i<ah.count;i++)maskHistogram.push(ah.getInteger(i));` : ''}
var hr=new ActionReference();hr.putEnumerated(charIDToTypeID('HstS'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));hr.putIdentifier(charIDToTypeID('Dcmn'),d.id);
var hd=executeActionGet(hr),hk=stringIDToTypeID('ID');if(!hd.hasKey(hk))throw new Error('HISTORY_ID_GATE');
return {active:{document_id:d.id,layer_id:d.activeLayer.id},selection:{present:has,bounds:bounds},getter:getter,am:am,
 state:{document:{id:d.id,name:d.name,width:d.width.as('px'),height:d.height.as('px'),resolution:d.resolution,
 mode:String(d.mode),depth:String(d.bitsPerChannel),saved:d.saved,quickMask:d.quickMaskMode,pixelAspectRatio:d.pixelAspectRatio},
 layers:layers,allChannels:channels,components:components,maskHistogram:maskHistogram},
 history:{id:hd.getInteger(hk),count:d.historyStates.length}};
}`;
}
export function pureScript(documentId, layerId, target) {
  return snapshotFunction(documentId, layerId, target) + '\nreturn snapshot();';
}
export function bracketScript(documentId, layerId, target, write = false) {
  if (write) assert.equal(target, 'rgb', 'FIXED_WRITE_RGB_TARGET_GATE');
  return snapshotFunction(documentId, layerId, target) + `
// Single synchronous operation-frame bracket.
var bracketBefore=snapshot();
${write ? `if(!bracketBefore.selection.present||String(bracketBefore.selection.bounds)!=='2,3,3,4')throw new Error('FIXED_ONE_PIXEL_SELECTION_GATE');
var c=new SolidColor();c.rgb.red=11;c.rgb.green=29;c.rgb.blue=53;
app.activeDocument.selection.fill(c,ColorBlendMode.NORMAL,100,false);` : ''}
var bracketAfter=snapshot();
return {before:bracketBefore,after:bracketAfter};`;
}
export function observationScript(documentId, layerId, target, serial) {
  const name = `'full-observation-${documentId}-${serial}'`;
  return snapshotFunction(documentId, layerId, target) + `
${guard(documentId, layerId)}
var before=null,temporary=null,copy=null,copyId=null,shape=[],counts=[],sameStructureBefore=null,sameStructureAfter=null;
var phase='source.snapshot.before',problem=null,cleanup=[],channelName=${name};
try{
 before=snapshot();
 if(!before.selection.present)throw new Error('SELECTION_REQUIRED');
 for(var i=0;i<d.channels.length;i++)if(d.channels[i].name===channelName)throw new Error('UNIQUE_ALPHA_REQUIRED');
 phase='source.alpha.add';
 temporary=d.channels.add();temporary.name=channelName;
 temporary.kind=ChannelType.MASKEDAREA;
 if(temporary.kind!==ChannelType.MASKEDAREA)throw new Error('FIXED_MASKEDAREA_KIND_GATE');
 phase='source.selection.store';d.selection.store(temporary,SelectionType.REPLACE);
 ${restoreTarget(target)}
 phase='source.snapshot.same-structure-before';sameStructureBefore=snapshot();
 phase='owned.duplicate';copy=d.duplicate('full-observation-owned-copy',false);copyId=copy.id;
 if(copyId===d.id)throw new Error('COPY_OWNERSHIP_GATE');
 var inherited=null;
 for(var i=0;i<copy.channels.length;i++)if(copy.channels[i].name===channelName){if(inherited)throw new Error('DUPLICATE_ALPHA_NAME_GATE');inherited=copy.channels[i];}
 if(!inherited||inherited.kind!==ChannelType.MASKEDAREA)throw new Error('INHERITED_ALPHA_GATE');
 phase='copy.alpha.target';copy.activeChannels=[inherited];
 phase='copy.alpha.visible';if(!inherited.visible)inherited.visible=true;
 if(!inherited.visible)throw new Error('COPY_ALPHA_VISIBLE_GATE');
 copy.selection.deselect(); // The copied selection is never an input to measurement.
 for(var y=0;y<8;y++)for(var x=0;x<8;x++){
  phase='copy.pixel.'+x+'.'+y;
  copy.selection.select([[UnitValue(x,'px'),UnitValue(y,'px')],[UnitValue(x+1,'px'),UnitValue(y,'px')],
   [UnitValue(x+1,'px'),UnitValue(y+1,'px')],[UnitValue(x,'px'),UnitValue(y+1,'px')]],SelectionType.REPLACE,0,false);
  var h=inherited.histogram;if(h.length!==256)throw new Error('HISTOGRAM_LENGTH_GATE');
  var count=0,value=0;for(var k=0;k<256;k++){count+=h[k];value+=k*h[k];}
  if(count!==1)throw new Error('EACH_PIXEL_HISTOGRAM_COUNT_ONE_GATE');
  counts.push(count);shape.push(value); // Raw: selected255/other0. Never invert or normalize.
 }
}catch(e){problem={phase:phase,message:String(e.message),number:e.number===undefined?null:e.number};}
// Sequential owned cleanup. Its first failure stops every later cleanup/COM action.
try{
 if(copy){phase='cleanup.owned-copy';copy.close(SaveOptions.DONOTSAVECHANGES);copy=null;cleanup.push('copy-closed');}
 phase='cleanup.original-active';app.activeDocument=d;
 ${restoreTarget(target)}
 if(sameStructureBefore){phase='source.snapshot.same-structure-after';sameStructureAfter=snapshot();}
 if(temporary){phase='cleanup.owned-alpha';temporary.remove();temporary=null;cleanup.push('alpha-removed');}
 phase='cleanup.original-target';${restoreTarget(target)}
}catch(e){return {ok:false,cleanupFailed:true,error:{phase:phase,message:String(e.message)},
 remaining:{copy_id:copy?copyId:null,source_id:d.id,temporary_channel:temporary?channelName:null},cleanup:cleanup,problem:problem};}
if(problem)return {ok:false,cleanupFailed:false,error:problem,remaining:{copy_id:null,temporary_channel:null},cleanup:cleanup};
phase='source.snapshot.after-cleanup';var after;
try{after=snapshot();}catch(e){return {ok:false,cleanupFailed:false,error:{phase:phase,message:String(e.message),number:e.number===undefined?null:e.number},
 remaining:{copy_id:null,temporary_channel:null},cleanup:cleanup};}
return {ok:true,before:before,after:after,sameStructureBefore:sameStructureBefore,sameStructureAfter:sameStructureAfter,
 shape:shape,counts:counts,cleanup:cleanup,copy_id:copyId,source_channel:channelName,alphaKind:String(ChannelType.MASKEDAREA)};`;
}
