import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

export async function readUnscopedChannels({ connection, owned,
  documentId, layerId, PhotoshopAPIFactory, toExtendScriptValue }) {
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
  // inspectDocuments and the scoped read each use the current connection's
  // direct operation lock. No harness-owned lock or target-selection scope.
  const document = (await connection.inspectDocuments()).find(d => d.id === documentId);
  if (!document) throw new Error('DOCUMENT_NOT_FOUND');
  return connection.withScope({}, async () => {
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
