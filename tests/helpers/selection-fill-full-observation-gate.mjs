import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePNG } from './selection-fill-native-decoder.mjs';
import { SOURCE_PATH, expectedRGBA } from './selection-fill-rgba-roundtrip-gate.mjs';
import { preflightWriterLock } from './selection-fill-am-channel-gate.mjs';
import { actualChannelScript, selectedFields } from './selection-fill-am-channel-calibration.mjs';
import { getterDiagnosticScript, producerScript, validateGetter } from './selection-fill-channel-identity-gate.mjs';

const PROJECT = 'selection-fill-native', TASK = 'disposable-p2';
const POLICY = 'D:/CodexProjects/.tmp/selection-fill-projects.json';
export const EVIDENCE_PATH = '.tmp/selection-fill-native/full-observation-visible-channel-gate-evidence';
export const CASES = Object.freeze([
  { label: 'opaque-one-rgb', shape: 'one', transparent: false, target: 'rgb' },
  { label: 'opaque-four-rgb', shape: 'four', transparent: false, target: 'rgb' },
  { label: 'transparent-one-rgb', shape: 'one', transparent: true, target: 'rgb' },
  { label: 'transparent-four-rgb', shape: 'four', transparent: true, target: 'rgb' },
  { label: 'opaque-four-mask', shape: 'four', transparent: false, target: 'mask' },
]);
// Two observations per case, each with its own actual before/after PNG; one write PNG.
export const EXPORT_PATHS = Object.freeze(Array.from({ length: 21 }, (_, i) =>
  `.tmp/selection-fill-native/${String(19 + i).padStart(3, '0')}.png`));
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

function resultValue(result) {
  if (result.isError) throw new Error('PUBLIC_TOOL_FAILED:' + JSON.stringify(result));
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const marker = text.lastIndexOf('\nResult: ');
  return JSON.parse(marker < 0 ? text : text.slice(marker + 9));
}
function validateSnapshot(snapshot, doc) {
  assert.deepEqual(snapshot.active, { document_id: doc.id, layer_id: doc.layer }, 'OWNED_ACTIVE_GATE');
  assert.deepEqual(snapshot.selection, { present: true,
    bounds: doc.shape === 'one' ? [2,3,3,4] : [1,1,7,7] }, 'FIXED_SELECTION_BOUNDS_GATE');
  const roster = snapshot.state.components;
  assert.equal(roster.length, 3, 'COMPONENT_ROSTER_GATE');
  assert.ok(roster.every(c => c.component === true), 'COMPONENT_KIND_GATE');
  if (doc.target === 'rgb') validateGetter(snapshot.getter, roster, doc.label);
  else {
    const mask = selectedFields(snapshot.am, doc.id, doc.layer);
    assert.ok(mask.channelName.length, 'MASK_NAME_GATE');
    assert.equal(mask.visible, false, 'MASK_TARGET_VISIBLE_GATE');
    assert.equal(mask.histogramCount, 256, 'MASK_TARGET_HISTOGRAM_GATE');
    assert.equal(snapshot.state.maskHistogram.length, 256, 'FULL_MASK_HISTOGRAM_GATE');
    assert.equal(snapshot.state.layers[0].mask.hasUserMask.value, true, 'OWNED_MASK_GATE');
  }
}

async function preflight(projects, project, root, matchesGrantedPath, samePath, out) {
  if (!samePath(root, project.root)) throw new Error('PROJECT_ROOT_MISMATCH');
  await projects.unchanged();
  const source = await projects.resolve(project, SOURCE_PATH, 'read');
  for (const tool of ['photoshop_create_document', 'photoshop_duplicate_document',
    'native_fixture', 'native_points', 'native_observe', 'photoshop_export_document'])
    projects.grant(project, TASK, tool, undefined, true);
  projects.grant(project, TASK, 'photoshop_close_document', undefined, true, true);
  projects.grant(project, TASK, 'photoshop_open_image', source);
  const dup = projects.grant(project, TASK, 'photoshop_duplicate_document', source);
  if (!dup.allow_new_documents) throw new Error('SOURCE_DUPLICATE_DENIED');
  projects.grant(project, TASK, 'photoshop_close_document', source, false, true);
  const outputGrant = projects.grant(project, TASK, 'photoshop_export_document', undefined, true);
  for (const path of EXPORT_PATHS) {
    const destination = await projects.resolve(project, path, 'write');
    if (!matchesGrantedPath(root, outputGrant.output_paths ?? [], destination)) throw new Error('EXACT_OUTPUT_GRANT_REQUIRED:' + path);
    await requireAbsent(destination);
  }
  compareRGBA(decodePNG(await readFile(source)), expectedRGBA());
  await requireAbsent(out);
  await preflightWriterLock(); // Real TMP only; never recover locks or pending files.
  return source;
}

async function run() {
  const root = fileURLToPath(new URL('../../', import.meta.url)), out = join(root, EVIDENCE_PATH);
  const owned = new Set(), events = [];
  const record = (event, data) => events.push({ event, data });
  let prepared = false, status = 'STOP', stage = 'preflight', slot = 0, serial = 0;
  let connection, registry, close, cleanupFailed = false;
  try {
    const { ProjectPolicy, matchesGrantedPath, samePath } = await import('../../dist/security/project-policy.js');
    const projects = await ProjectPolicy.load(POLICY), project = projects.get(PROJECT);
    const source = await preflight(projects, project, root, matchesGrantedPath, samePath, out);
    await mkdir(out); prepared = true;
    record('preflight', { source: SOURCE_PATH, exports: EXPORT_PATHS, independentSourceRGBA: [...expectedRGBA()] });
    const [{ PhotoshopConnection }, { ToolPolicy }, { ToolRegistry }, { createDocumentTools },
      { createImagePlacementTools }, { createAdvancedTools }, { nativeTools },
      { PhotoshopAPIFactory }, { toExtendScriptValue }] = await Promise.all([
      import('../../dist/platform/connection.js'), import('../../dist/security/tool-policy.js'),
      import('../../dist/core/tool-registry.js'), import('../../dist/tools/document-tools.js'),
      import('../../dist/tools/image-placement-tools.js'), import('../../dist/tools/advanced-tools.js'),
      import('./selection-fill-native-tools.mjs'), import('../../dist/api/photoshop-api.js'),
      import('../../dist/core/serializer.js'),
    ]);
    connection = new PhotoshopConnection();
    registry = new ToolRegistry(new ToolPolicy(projects, connection));
    const publicNames = new Set(['photoshop_create_document', 'photoshop_get_active_context',
      'photoshop_open_image', 'photoshop_duplicate_document', 'photoshop_export_document', 'photoshop_close_document']);
    for (const definition of [...createDocumentTools(connection), ...createImagePlacementTools(connection),
      ...createAdvancedTools(connection, (name, args) => registry.execute(name, args))])
      if (publicNames.has(definition.tool.name)) registry.register(definition.tool.name, definition);
    const natives = nativeTools(connection, owned), fixture = natives.find(d => d.tool.name === 'native_fixture');
    const points = natives.find(d => d.tool.name === 'native_points');
    registry.register('native_points', points);
    registry.register('native_fixture', {
      tool: { ...fixture.tool, inputSchema: { type: 'object', properties: {
        operation: { type: 'string', enum: ['opaque', 'mask-fixture', 'rgb', 'mask'] },
      }, required: ['operation'] } },
      handler: async args => {
        if (!owned.has(args.document_id)) throw new Error('UNOWNED_DOCUMENT');
        if (['opaque', 'mask-fixture'].includes(args.operation)) return fixture.handler({ ...args,
          opaque: true, variant: args.operation === 'mask-fixture' ? 'mask' : 'normal' });
        const api = await new PhotoshopAPIFactory(connection).createAPI();
        const value = await api.executeScript(producerScript(toExtendScriptValue(args.document_id),
          toExtendScriptValue(args.layer_id), args.operation === 'rgb' ? 'all' : 'mask'), 15000);
        return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
      },
    });
    const call = async (name, args = {}, doc) => {
      stage = name;
      if (doc && !owned.has(doc.id)) throw new Error('UNOWNED_DOCUMENT');
      const result = await registry.execute(name, { project_id: PROJECT, task_id: TASK, ...args,
        ...(doc ? { document_id: doc.id } : {}),
        ...(doc?.layer && name.startsWith('native_') ? { layer_id: doc.layer } : {}),
      });
      if (result.isError) throw new Error('PUBLIC_TOOL_FAILED:' + JSON.stringify(result));
      // The existing close handler returns success prose, rather than JSON.
      return name === 'photoshop_close_document' ? { closed: true } : resultValue(result);
    };
    const remember = id => {
      assert.ok(Number.isInteger(id) && id > 0 && !owned.has(id), 'NEW_OWNED_ID_GATE');
      owned.add(id); return id;
    };
    close = async doc => {
      try { await call('photoshop_close_document', { save: false }, doc); }
      catch (error) { cleanupFailed = true; throw error; }
      owned.delete(doc.id); record('owned-document-closed', { id: doc.id });
    };
    // Same unscoped grant/session/operation-lock pattern as the passed identity read.
    // No document/layer target setters are supplied to withScope, including the write bracket.
    const unscoped = async (doc, tool, execute, mutations = false, bracketWrite = false) => {
      if (!owned.has(doc.id)) throw new Error('UNOWNED_DOCUMENT');
      const document = (await connection.inspectDocuments()).find(d => d.id === doc.id);
      if (!document || document.path) throw new Error('OWNED_UNSAVED_DOCUMENT_REQUIRED');
      const recheck = async () => {
        if (!owned.has(doc.id)) throw new Error('UNOWNED_DOCUMENT');
        await projects.unchanged();
        projects.grant(project, TASK, tool, undefined, true);
        if (bracketWrite) projects.grant(project, TASK, 'native_points', undefined, true);
        if (mutations) {
          projects.grant(project, TASK, 'native_fixture', undefined, true);
          projects.grant(project, TASK, 'photoshop_duplicate_document', undefined, true);
          projects.grant(project, TASK, 'photoshop_close_document', undefined, true, true);
        }
      };
      await recheck();
      return connection.withScope({ recheck }, execute);
    };
    const read = async (doc, full = false) => {
      stage = doc.label + (full ? ':full' : ':pure');
      return unscoped(doc, 'native_observe', async () => {
        const api = await new PhotoshopAPIFactory(connection).createAPI();
        const id = toExtendScriptValue(doc.id), layer = toExtendScriptValue(doc.layer);
        const value = await api.executeScript(full ? observationScript(id, layer, doc.target, ++serial)
          : pureScript(id, layer, doc.target), 30000);
        if (full && value.cleanupFailed === true) cleanupFailed = true;
        record(full ? 'actual-full' : 'actual-pure', { label: doc.label, value });
        if (full) assert.equal(value.ok, true, 'FULL_OBSERVATION_STOP:' + JSON.stringify(value));
        else validateSnapshot(value, doc);
        return value;
      }, full);
    };
    const bracket = async (doc, write = false) => {
      stage = doc.label + (write ? ':fixed-one-pixel-bracket' : ':pure-no-action-bracket');
      return unscoped(doc, 'native_observe', async () => {
        const api = await new PhotoshopAPIFactory(connection).createAPI();
        // One executeScript keeps both pure reads and the optional fixed fill in
        // the same existing operation frame. No nested scope or target setters.
        const value = await api.executeScript(bracketScript(toExtendScriptValue(doc.id),
          toExtendScriptValue(doc.layer), doc.target, write), 30000);
        validateSnapshot(value.before, doc); validateSnapshot(value.after, doc);
        return historyBracket(value.before, value.after, write);
      }, false, write);
    };
    const setTarget = doc => call('native_fixture', { operation: doc.target }, doc);
    const exportPixels = async (doc, label, expected) => {
      stage = doc.label + ':export:' + label;
      const path = EXPORT_PATHS[slot];
      assert.ok(path, 'EXACT_EXPORT_BUDGET_GATE');
      const destination = await projects.resolve(project, path, 'write');
      const grant = projects.grant(project, TASK, 'photoshop_export_document', undefined, true);
      if (!matchesGrantedPath(root, grant.output_paths ?? [], destination)) throw new Error('EXACT_OUTPUT_GRANT_REQUIRED');
      await requireAbsent(destination);
      await call('photoshop_export_document', { path, format: 'PNG' }, doc); slot++;
      const decoded = decodePNG(await readFile(destination));
      record('actual-export', { label: doc.label, phase: label, path, rgba: [...decoded.rgba], expected: [...expected] });
      compareRGBA(decoded, expected);
      return decoded.rgba;
    };
    const opened = await call('photoshop_open_image', { filePath: SOURCE_PATH });
    const sourceDoc = { id: remember(opened.id) };
    record('owned-source-opened', { id: sourceDoc.id, path: SOURCE_PATH });
    for (const spec of CASES) {
      const created = spec.transparent
        ? await call('photoshop_duplicate_document', { newName: spec.label }, sourceDoc)
        : await call('photoshop_create_document', { width: 8, height: 8, resolution: 72, colorMode: 'RGB' });
      const doc = { ...spec, id: remember(created.id) };
      const context = await call('photoshop_get_active_context', {}, doc);
      doc.layer = context.activeLayer?.id;
      assert.ok(Number.isInteger(doc.layer), 'OWNED_LAYER_ID_GATE');
      if (!spec.transparent) {
        const output = await call('native_fixture', { operation: spec.target === 'mask' ? 'mask-fixture' : 'opaque' }, doc);
        doc.layer = output.layer_id;
        assert.ok(Number.isInteger(doc.layer), 'FIXTURE_LAYER_ID_GATE');
      }
      await call('native_points', { shape: spec.shape }, doc);
      await setTarget(doc);
      const expected = spec.transparent ? expectedRGBA() : expectedOpaque();
      record('independent-case-input', { ...doc, rawMask: expectedMask(spec.shape), rgba: [...expected] });
      record('pure-no-action-bracket', { label: doc.label, ...await bracket(doc) });
      let restoredBaseline;
      for (let observation = 0; observation < 2; observation++) {
        const beforeRGBA = await exportPixels(doc, `observation-${observation}-before`, expected);
        await setTarget(doc); // Export/setup actions are outside all history brackets.
        const before = await read(doc);
        if (restoredBaseline) compareState(restoredBaseline, before);
        const output = await read(doc, true);
        compareRawShape(output.shape, output.counts, doc.shape);
        validateSnapshot(output.before, doc); validateSnapshot(output.after, doc);
        compareState(before, output.before);
        compareState(output.before, output.after);
        compareState(output.sameStructureBefore, output.sameStructureAfter);
        assert.deepEqual(output.cleanup, ['copy-closed', 'alpha-removed'], 'OWNED_OBSERVER_CLEANUP_GATE');
        const restored = await read(doc);
        compareState(before, restored);
        const afterRGBA = await exportPixels(doc, `observation-${observation}-after`, expected);
        assert.deepEqual(afterRGBA, beforeRGBA, 'ACTUAL_BEFORE_AFTER_RGBA_GATE');
        await setTarget(doc);
        compareState(before, await read(doc));
        restoredBaseline = restored;
        record('full-observation-restored', { label: doc.label, observation, full64: true,
          sameStructureCompared: true, originalStructureCompared: true,
          historyBefore: output.before.history, historyAfter: output.after.history,
          fullHistoryInvariantClaimed: false });
      }
      if (doc.label === 'opaque-one-rgb') {
        // Target/selection already fixed outside this single synchronous bracket.
        record('real-write-bracket', { label: doc.label, ...await bracket(doc, true) });
        await exportPixels(doc, 'fixed-one-pixel-write-after', expectedOpaque(true));
      }
      await close(doc);
      record('case-passed', { label: doc.label, scope: 'full-observation-only' });
    }
    await close(sourceDoc);
    assert.equal(slot, EXPORT_PATHS.length, 'EXACT_USED_EXPORT_COUNT_GATE');
    assert.equal(owned.size, 0, 'ALL_OWNED_DOCUMENTS_CLOSED_GATE');
    // Source is read again, never rewritten or replaced by native_fixture.
    compareRGBA(decodePNG(await readFile(source)), expectedRGBA());
    status = 'PASS';
    record('PASS', { fullObservationGatePassed: true, observerRepairAllowed: true,
      nextUnit: 'original-observer-repair', fillP2MatrixComplete: false, p3Complete: false });
  } catch (error) {
    const primaryStage = stage;
    // Close only known owned IDs after a known failure. Never retry a failed
    // cleanup, dispatch unknown work, or delete locks/pending files.
    const cleanup = await cleanupOwnedAfterFailure({ owned, connection, registry, close, error, cleanupFailed });
    record('STOP', { stage: primaryStage, error: String(error), cleanup, remainingOwned: [...owned],
      fullObservationGatePassed: false, observerRepairAllowed: false });
  }
  if (prepared) {
    try { await writeFile(join(out, 'evidence.json'), JSON.stringify(events, null, 2), { flag: 'wx' }); }
    catch (error) { status = 'STOP'; console.error('EVIDENCE_WRITE_STOP:' + String(error)); }
  }
  console.log(JSON.stringify({ status, evidence: prepared ? join(out, 'evidence.json') : null,
    ...(prepared ? {} : { events }), remainingOwned: [...owned],
    fullObservationGatePassed: status === 'PASS', observerRepairAllowed: status === 'PASS',
    fillP2MatrixComplete: false, p3Complete: false }));
  process.exitCode = status === 'PASS' ? 0 : 1;
}

export async function main(args = process.argv.slice(2), execute = run) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log('Preparation only; default/help has no COM or writes. --run: tester only, normal Windows permissions, fresh full-observation-visible-channel-gate-evidence directory and exact PNG slots019..039. Five owned cases; fixed MASKEDAREA raw255/0, full64, state and full256 RGBA restoration. Invisible source channel histograms are unavailable; full64 alpha measurement uses the visible owned copy. Failure STOP, no retry/recovery/pending deletion. PASS permits only the original observer repair unit; no P2 matrix/P3 completion claim.');
    return;
  }
  if (args.length !== 1 || args[0] !== '--run') throw new Error('Only --help or --run is accepted.');
  await execute();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
