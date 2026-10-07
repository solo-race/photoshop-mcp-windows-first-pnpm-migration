import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log('Preparation only; default/help never imports Photoshop code or uses COM.\n--run: once-only AM field discovery on a NEW owned 8x8 mask fixture. Photoshop must already be open. Existing evidence/lock refuses. Records unscoped pure descriptors twice without switching channels. Exit 2 means BLOCKED: identity interpretation, restoration, 64-pixel shape/RGBA/active gate still require this runtime evidence. No native observer repair is authorized by RECORDED evidence.');
} else if (args.length === 1 && args[0] === '--run') {
  await run();
} else {
  console.error('Only --help or --run is accepted.');
  process.exitCode = 1;
}
}

async function run() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = join(root, '.tmp', 'selection-fill-am-channel-gate-inventory-normal-evidence');
  const owned = new Set(), evidence = [];
  let prepared = false, registry;
  let stage = 'preflight';
  const record = (event, data) => evidence.push({ event, data });
  const call = async (name, args = {}, documentId, layerId) => {
    stage = name;
    if (documentId !== undefined && !owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
    const result = await registry.execute(name, {
      project_id: 'selection-fill-native', task_id: 'disposable-p2', ...args,
      ...(documentId === undefined ? {} : { document_id: documentId }),
      ...(layerId === undefined ? {} : { layer_id: layerId }),
    });
    if (result.isError) throw new Error('TOOL_FAILED:' + name + ':' + JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  };
  try {
    await preflightWriterLock(); // Read-only refusal; no lifetime lock or reclamation.
    await mkdir(out); // A second run refuses before COM; retain all evidence.
    prepared = true;
    const [{ PhotoshopConnection }, { ProjectPolicy }, { ToolPolicy }, { ToolRegistry },
      { createDocumentTools }, { createAdvancedTools }, { nativeTools },
      { PhotoshopAPIFactory }, { toExtendScriptValue }] = await Promise.all([
      import('../../dist/platform/connection.js'), import('../../dist/security/project-policy.js'),
      import('../../dist/security/tool-policy.js'), import('../../dist/core/tool-registry.js'),
      import('../../dist/tools/document-tools.js'), import('../../dist/tools/advanced-tools.js'),
      import('./selection-fill-native-tools.mjs'), import('../../dist/api/photoshop-api.js'),
      import('../../dist/core/serializer.js'),
    ]);
    const connection = new PhotoshopConnection();
    const projects = await ProjectPolicy.load('D:/CodexProjects/.tmp/selection-fill-projects.json');
    const project = projects.get('selection-fill-native');
    const names = new Set(['photoshop_create_document', 'photoshop_close_document',
      'photoshop_get_active_context', 'native_fixture']);
    for (const name of [...names, 'native_observe']) if (name !== 'photoshop_get_active_context')
      projects.grant(project, 'disposable-p2', name, undefined, true, name === 'photoshop_close_document');
    registry = new ToolRegistry(new ToolPolicy(projects, connection));
    for (const definition of [
      ...createDocumentTools(connection),
      ...createAdvancedTools(connection, (name, args) => registry.execute(name, args)),
      ...nativeTools(connection, owned),
    ]) if (names.has(definition.tool.name)) registry.register(definition.tool.name, definition);
    const created = await call('photoshop_create_document', { width: 8, height: 8, resolution: 72, colorMode: 'RGB' });
    if (!Number.isInteger(created.id)) throw new Error('CREATED_ID_GATE');
    // Never use an existing document ID, including the closed 4051 fixture.
    owned.add(created.id);
    const context = await call('photoshop_get_active_context', {}, created.id);
    if (!Number.isInteger(context.activeLayer?.id)) throw new Error('LAYER_ID_GATE');
    const fixture = await call('native_fixture', { variant: 'mask', opaque: true }, created.id, context.activeLayer.id);
    if (!Number.isInteger(fixture.layer_id)) throw new Error('FIXTURE_LAYER_GATE');
    record('fixture', { document_id: created.id, ...fixture });

    const pure = () => readUnscopedChannels({ connection, projects, project, owned,
      documentId: created.id, layerId: fixture.layer_id, PhotoshopAPIFactory, toExtendScriptValue });
    stage = 'unscoped-pure-before';
    const before = await pure();
    record('unscoped-pure-before', before);
    for (const row of before.candidates) if (!row.ok) throw new Error('AM_DESCRIPTOR_READ_GATE:' + JSON.stringify(row));
    stage = 'unscoped-pure-after';
    const after = await pure(); // No operation or target selection between these reads.
    record('unscoped-pure-after', after);
    assert.deepEqual(after, before, 'AM_PURE_DESCRIPTOR_STABILITY_GATE');
    record('BLOCKED', {
      dependency: 'Use this top-level inventory to identify evidenced channel fields before targeted extraction; inventory is not channel identity.',
      inventoryOnly: true, identityVerified: false,
      pending: ['actual mask/RGB/alpha identity calibration', 'restoration followed by unscoped pure verification',
        'independent full 64-pixel shape and RGBA calibration', 'before/after shape, RGBA and active state equality'],
      observerRepairAllowed: false,
    });
    process.exitCode = 2;
  } catch (error) {
    record('STOP', { stage, error: String(error) });
    process.exitCode = 1;
  } finally {
    try {
      if (registry) for (const id of owned) {
        try {
          const result = await registry.execute('photoshop_close_document', {
            project_id: 'selection-fill-native', task_id: 'disposable-p2', document_id: id, save: false,
          });
          if (result.isError) throw new Error(JSON.stringify(result));
          owned.delete(id);
          record('cleanup', { document_id: id, closed: true });
        } catch (error) {
          record('cleanup-STOP', { document_id: id, error: String(error), remaining: [...owned] });
          process.exitCode = 1;
          break; // Session fault/cleanup failure stops; never reset or retry COM.
        }
      }
    } finally {
      if (prepared) await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
    }
    console.log(JSON.stringify({ status: process.exitCode === 2 ? 'BLOCKED' : 'STOP',
      evidence: prepared ? join(out, 'evidence.json') : null }));
  }
}

export async function preflightWriterLock(directory = join(tmpdir(), 'photoshop-mcp-single-writer')) {
  for (const path of [directory, directory + '.recovery']) {
    try {
      await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('WRITER_LOCK_UNCERTAIN');
    }
    throw new Error('WRITER_LOCK_EXISTS');
  }
}

export async function readUnscopedChannels({ connection, projects, project, owned,
  documentId, layerId, PhotoshopAPIFactory, toExtendScriptValue }) {
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
  // inspectDocuments and the scoped read each use the current connection's
  // direct operation lock. No harness-owned lock or target-selection scope.
  const document = (await connection.inspectDocuments()).find(d => d.id === documentId);
  if (!document) throw new Error('DOCUMENT_NOT_REGISTERED');
  const documentPath = document.path ? await projects.documentPath(project, document.path) : undefined;
  const recheck = async () => {
    if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
    await projects.unchanged();
    if (documentPath) await projects.documentPath(project, documentPath);
    projects.grant(project, 'disposable-p2', 'native_observe', documentPath, !documentPath);
  };
  await recheck();
  return connection.withScope({ recheck }, async () => {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    return api.executeScript(channelScript(toExtendScriptValue(documentId), toExtendScriptValue(layerId)), 15000);
  });
}

export function channelScript(documentId, layerId) {
  return `
var d=app.activeDocument;
if(d.id!==${documentId}||d.activeLayer.id!==${layerId})throw new Error('OWNED_ACTIVE_TARGET_CHANGED');
var saved=false;try{d.fullName;saved=true;}catch(unsaved){}
if(saved||d.width.as('px')!==8||d.height.as('px')!==8||d.mode!==DocumentMode.RGB||d.bitsPerChannel!==BitsPerChannelType.EIGHT)throw new Error('OWNED_RGB8_FIXTURE_GATE');
var budget=512;
var phase='',referenceTrace=[];
function attempt(label,fn){try{return {candidate:label,ok:true,value:fn()};}catch(e){return {candidate:label,ok:false,error:{message:String(e.message),number:e.number===undefined?null:e.number}};}}
// Quote reserved property names for ExtendScript (previous diagnostics failed here).
function id(n){return {id:n,string:attempt('typeIDToStringID',function(){return typeIDToStringID(n);}),'char':attempt('typeIDToCharID',function(){return typeIDToCharID(n);})};}
function reference(r,source,inputLength){
 var chain=[];
 for(var i=0;i<8;i++){
  phase='format.reference.'+source+'['+i+'].getDesiredClass';
  var desiredClass;
  try{desiredClass=r.getDesiredClass();}
  catch(empty){
   // Only the returned tail beyond our explicitly constructed input chain is
   // evidenced as empty (4097 phase evidence). This is not channel identity.
   if(source!=='input'||i===0||i!==inputLength||empty.number!==1205)throw empty;
   referenceTrace.push({source:source,depth:i,terminal:'empty-returned',error:{message:String(empty.message),number:empty.number}});
   return chain;
  }
  if(source==='input'&&i>=inputLength)throw new Error('AM_REFERENCE_LENGTH_GATE');
  phase='format.reference.'+source+'['+i+'].getForm';
  var f=r.getForm(),item={desiredClass:id(desiredClass),form:String(f)};
  phase='format.reference.'+source+'['+i+'].value';
  if(f===ReferenceFormType.ENUMERATED)item.value={type:id(r.getEnumeratedType()),value:id(r.getEnumeratedValue())};
  else if(f===ReferenceFormType.IDENTIFIER)item.value=r.getIdentifier();
  else if(f===ReferenceFormType.INDEX)item.value=r.getIndex();
  else if(f===ReferenceFormType.NAME)item.value=r.getName();
  else if(f===ReferenceFormType.OFFSET)item.value=r.getOffset();
  else if(f===ReferenceFormType.PROPERTY)item.value=id(r.getProperty());
  chain.push(item);
  referenceTrace.push({source:source,depth:i,item:item});
  phase='format.reference.'+source+'['+i+'].getContainer';
  var parent;
  try{parent=r.getContainer();referenceTrace.push({source:source,depth:i,container:'returned'});}
  catch(end){
   referenceTrace.push({source:source,depth:i,container:'threw',error:{message:String(end.message),number:end.number===undefined?null:end.number}});
   if(end.number!==1205||(source==='input'&&i!==inputLength-1))throw end;
   return chain;
  }
  r=parent;
 }
 throw new Error('AM_REFERENCE_DEPTH_GATE');
}
function scalar(c,k,t){
 if(t===DescValueType.BOOLEANTYPE)return c.getBoolean(k);
 if(t===DescValueType.INTEGERTYPE)return c.getInteger(k);
 if(t===DescValueType.LARGEINTEGERTYPE)return c.getLargeInteger(k);
 if(t===DescValueType.DOUBLETYPE)return c.getDouble(k);
 if(t===DescValueType.STRINGTYPE)return c.getString(k);
 if(t===DescValueType.CLASSTYPE)return id(c.getClass(k));
 if(t===DescValueType.ENUMERATEDTYPE)return {type:id(c.getEnumerationType(k)),value:id(c.getEnumerationValue(k))};
 if(t===DescValueType.UNITDOUBLE)return {unit:id(c.getUnitDoubleType(k)),value:c.getUnitDoubleValue(k)};
 // No necessary complex identity field has been established. Do not traverse
 // descriptor references or objects, or interpret input references as identity.
 if(t===DescValueType.REFERENCETYPE)return {valueNotRead:true};
 if(t===DescValueType.OBJECTTYPE)return {'class':id(c.getObjectType(k)),valueNotRead:true};
 if(t===DescValueType.LISTTYPE){
  return {count:c.getList(k).count,valueNotRead:true}; // Metadata only; no list items.
 }
 return {scalarNotRead:true}; // Never infer channel identity from an unread value.
}
function descriptor(desc,result){
 for(var i=0;i<desc.count;i++){
  phase='format.descriptor';
  if(--budget<0)throw new Error('AM_DESCRIPTOR_BUDGET_GATE');
  phase='format.descriptor['+i+'].getKey';var k=desc.getKey(i);
  phase='format.descriptor['+i+'].getType';var t=desc.getType(k);
  var entry={key:id(k),type:String(t)};result.keys.push(entry);
  phase='format.descriptor['+i+'].value';entry.value=scalar(desc,k,t);
 }
}
function candidate(label,build,inputLength){
 var row={candidate:label,ok:false,executeActionGet:{started:false,succeeded:false}};
 budget=512;referenceTrace=[];
 try{
  phase='reference.build';var r=build();
  phase='executeActionGet';row.executeActionGet.started=true;
  var desc=executeActionGet(r);row.executeActionGet.succeeded=true;
  row.value={};phase='format.reference.input';row.value.reference=reference(r,'input',inputLength);
  phase='format.descriptor';row.value.descriptor={count:desc.count,keys:[],inventoryOnly:true,identityVerified:false};
  descriptor(desc,row.value.descriptor);
  row.ok=true;
 }catch(e){row.error={phase:phase,message:String(e.message),number:e.number===undefined?null:e.number};}
 row.referenceTrace=referenceTrace;
 return row;
}
function current(qualified){var r=new ActionReference();r.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));if(qualified)r.putIdentifier(charIDToTypeID('Dcmn'),d.id);return r;}
var rows=[];
rows.push(candidate('current channel/document-qualified',function(){return current(true);},2));
rows.push(candidate('current channel/unscoped actual active',function(){return current(false);},1));
rows.push(candidate('owned document descriptor',function(){var r=new ActionReference();r.putIdentifier(charIDToTypeID('Dcmn'),d.id);return r;},1));
return {active:{document_id:app.activeDocument.id,layer_id:app.activeDocument.activeLayer.id},candidates:rows,readOnly:true,inventoryOnly:true,identityVerified:false};`;
}
