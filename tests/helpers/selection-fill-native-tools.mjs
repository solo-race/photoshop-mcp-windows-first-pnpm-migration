import { PhotoshopAPIFactory } from '../../dist/api/photoshop-api.js';
import { channelMetadataScript } from './selection-fill-full-observation-gate.mjs';

// Read only: keep the real policy grant and session guard without selecting a target.
export async function nativePureRead(connection, owned, projects, documentId, options = {}) {
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
  const project = projects.get('selection-fill-native');
  const document = (await connection.inspectDocuments()).find(d => d.id === documentId);
  if (!document) throw new Error('DOCUMENT_NOT_REGISTERED');
  const documentPath = document.path
    ? await projects.documentPath(project, document.path) : undefined;
  const recheck = async () => {
    if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
    await projects.unchanged();
    if (documentPath) await projects.documentPath(project, documentPath);
    projects.grant(project, 'disposable-p2', 'native_observe', documentPath, !documentPath);
  };
  await recheck();
  const definition = nativeTools(connection, owned).find(d => d.tool.name === 'native_observe');
  return connection.withScope({ recheck }, () => definition.handler({
    ...options, document_id: documentId, pure: true, history: true,
  }));
}

// Only this disposable batch may call these fixed helpers through its registry.
export function nativeTools(connection, owned) {
  const definition = (name, properties, build) => ({
    tool: { name, description: 'Disposable 8x8 native acceptance helper', inputSchema: { type: 'object', properties } },
    handler: async args => {
      if (!owned.has(args.document_id)) throw new Error('UNOWNED_DOCUMENT');
      let api;
      try {
        api = await new PhotoshopAPIFactory(connection).createAPI();
      } catch (error) {
        if (name === 'native_observe') error.message += ' [native_observe phase=factory.createAPI]';
        throw error;
      }
      let result;
      try {
        result = await api.executeScript(build(args));
      } catch (error) {
        if (name === 'native_observe') error.message += ' [native_observe phase=api.executeScript]';
        throw error;
      }
      if (name === 'native_observe' && result?.ok === false) {
        const error = new Error(result.error.message + ' [native_observe step=' + result.error.phase + ']');
        error.completion = 'finished';
        error.cleanupFailed = result.cleanupFailed === true;
        error.observation = result;
        throw error;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  });
  return [
    definition('native_fixture', { variant: { type: 'string' }, opaque: { type: 'boolean' } }, args => {
      const variants = ['normal', 'locked', 'text', 'smartobject', 'alpha', 'mask', 'gray', 'depth16'];
      if (!variants.includes(args.variant) || typeof args.opaque !== 'boolean') throw new Error('INVALID_FIXTURE');
      return `
var d=app.activeDocument;
if(d.width.as('px')!==8||d.height.as('px')!==8||d.layers.length!==1)throw new Error('FIXTURE_SIZE');
// Replace only this owned disposable document's initial layer; do not assume its fill or background kind.
var initial=d.activeLayer;var l=d.artLayers.add();l.kind=LayerKind.NORMAL;l.name='native-pixel';
d.activeLayer=l;initial.remove();
if(l.typename!=='ArtLayer'||l.kind!==LayerKind.NORMAL||l.isBackgroundLayer||l.allLocked||l.pixelsLocked||l.transparentPixelsLocked||l.positionLocked)throw new Error('NATIVE_PIXEL_FIXTURE_GATE');
d.quickMaskMode=false;d.activeChannels=d.componentChannels;
d.selection.selectAll();d.selection.clear();
if(${args.opaque}){var c=new SolidColor();c.rgb.red=23;c.rgb.green=47;c.rgb.blue=89;d.selection.fill(c,ColorBlendMode.NORMAL,100,false);}
d.selection.deselect();
var variant=${JSON.stringify(args.variant)};
if(variant==='locked')l.allLocked=true;
if(variant==='text')l.kind=LayerKind.TEXT;
if(variant==='smartobject'){
 executeAction(stringIDToTypeID('newPlacedLayer'),undefined,DialogModes.NO);
 if(d.activeLayer.kind!==LayerKind.SMARTOBJECT)throw new Error('NATIVE_SMARTOBJECT_FIXTURE_GATE');
}
if(variant==='alpha'){var a=d.channels.add();a.name='native-alpha';d.activeChannels=[a];}
if(variant==='mask'){
 var md=new ActionDescriptor();md.putClass(charIDToTypeID('Nw  '),charIDToTypeID('Chnl'));
 var mr=new ActionReference();mr.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Chnl'),charIDToTypeID('Msk '));
 md.putReference(charIDToTypeID('At  '),mr);md.putEnumerated(charIDToTypeID('Usng'),charIDToTypeID('UsrM'),charIDToTypeID('RvlA'));executeAction(charIDToTypeID('Mk  '),md,DialogModes.NO);
}
if(variant==='gray')d.changeMode(ChangeMode.GRAYSCALE);
if(variant==='depth16')d.bitsPerChannel=BitsPerChannelType.SIXTEEN;
return {layer_id:d.activeLayer.id,variant:variant};`;
    }),
    definition('native_points', { shape: { type: 'string' } }, args => {
      const shapes = { none: [], one: [[2,3]], four: [[1,1],[5,1],[2,5],[6,6]],
        point0: [[1,1]], point1: [[5,1]], point2: [[2,5]], point3: [[6,6]] };
      if (args.shape === 'calibrate') return `var c=new SolidColor();c.rgb.red=11;c.rgb.green=29;c.rgb.blue=53;app.activeDocument.selection.fill(c,ColorBlendMode.NORMAL,100,false);return {calibration:'pixel-fill-only'};`;
      if (!Object.hasOwn(shapes, args.shape)) throw new Error('INVALID_SHAPE');
      return `var d=app.activeDocument;var p=${JSON.stringify(shapes[args.shape])};d.selection.deselect();
for(var i=0;i<p.length;i++){var x=p[i][0],y=p[i][1];d.selection.select([[UnitValue(x,'px'),UnitValue(y,'px')],[UnitValue(x+1,'px'),UnitValue(y,'px')],[UnitValue(x+1,'px'),UnitValue(y+1,'px')],[UnitValue(x,'px'),UnitValue(y+1,'px')]],i===0?SelectionType.REPLACE:SelectionType.EXTEND,0,false);}return {shape:${JSON.stringify(args.shape)}};`;
    }),
    definition('native_observe', { history: { type: 'boolean' }, pure: { type: 'boolean' },
      mask_target: { type: 'boolean' }, no_raw_pixels: { type: 'boolean' } }, nativeObserverScript),
  ];
}

// Compare only the plain snapshot values, using ES3 primitives available in ExtendScript.
export function nativeSnapshotEqualScript() {
  return `
function snapshotEqual(a,b){
 if(a===b)return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
 var arrayA=Object.prototype.toString.call(a)==='[object Array]';
 var arrayB=Object.prototype.toString.call(b)==='[object Array]';
 if(arrayA!==arrayB||(arrayA&&a.length!==b.length))return false;
 var countA=0,countB=0,key;
 for(key in a)if(Object.prototype.hasOwnProperty.call(a,key)){
  countA++;
  if(!Object.prototype.hasOwnProperty.call(b,key)||!snapshotEqual(a[key],b[key]))return false;
 }
 for(key in b)if(Object.prototype.hasOwnProperty.call(b,key))countB++;
 return countA===countB;
}`;
}

// Getter first; the fallback is restricted to an independently produced RGB8 mask.
export function nativeTargetScript(maskTarget = false) {
  return `
${nativeSnapshotEqualScript()}
function readTarget(){
 var channels,phase='activeChannels.getter';
 try{
  channels=d.activeChannels;
  phase='activeChannels.length';var length=channels.length,rows=[],objects=[];
  for(var i=0;i<length;i++){
   phase='activeChannels['+i+'].name';var name=channels[i].name;
   phase='activeChannels['+i+'].kind';var kind=channels[i].kind;
   if(kind===undefined||kind===null)throw new Error('CHANNEL_TYPE_GATE');
   rows.push({name:name,kind:String(kind)});objects.push(channels[i]);
  }
  return {method:'getter',channels:rows,objects:objects,getterError:null,am:null};
 }catch(e){
  var getterError={message:String(e.message),number:e.number===undefined?null:e.number,phase:phase};
  if(phase!=='activeChannels.getter'||!${maskTarget === true}||d.mode!==DocumentMode.RGB||d.bitsPerChannel!==BitsPerChannelType.EIGHT
   ||app.activeDocument.id!==d.id||app.activeDocument.activeLayer.id!==d.activeLayer.id)throw e;
  var lr=new ActionReference();lr.putIdentifier(charIDToTypeID('Lyr '),d.activeLayer.id);
  var ld=executeActionGet(lr),mk=stringIDToTypeID('hasUserMask');
  if(!ld.hasKey(mk)||ld.getType(mk)!==DescValueType.BOOLEANTYPE||ld.getBoolean(mk)!==true)throw e;
  var ar=new ActionReference();ar.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));
  var ad=executeActionGet(ar);
  function field(key,type,get){
   var k=stringIDToTypeID(key);if(!ad.hasKey(k)||ad.getType(k)!==type)throw new Error('MASK_AM_FIELD_GATE:'+key+' getter='+getterError.message);
   return get(k);
  }
  var am={channelName:field('channelName',DescValueType.STRINGTYPE,function(k){return ad.getString(k);}),
   itemIndex:field('itemIndex',DescValueType.INTEGERTYPE,function(k){return ad.getInteger(k);}),
   count:field('count',DescValueType.INTEGERTYPE,function(k){return ad.getInteger(k);}),
   visible:field('visible',DescValueType.BOOLEANTYPE,function(k){return ad.getBoolean(k);})};
  var hist=field('histogram',DescValueType.LISTTYPE,function(k){return ad.getList(k);});
  if(!am.channelName||am.visible!==false||hist.count!==256)throw new Error('MASK_AM_IDENTITY_GATE getter='+getterError.message);
  am.histogram=[];for(var i=0;i<hist.count;i++)am.histogram.push(hist.getInteger(i));
  return {method:'mask-AM',channels:[{name:am.channelName,kind:'layer-mask'}],objects:null,getterError:getterError,am:am};
 }
}
function targetState(target){
 return {method:target.method,channels:target.channels,getterError:target.getterError,am:target.am};
}
function restoreTarget(original){
 if(original.method==='mask-AM'){
  var mr=new ActionReference();mr.putEnumerated(charIDToTypeID('Chnl'),charIDToTypeID('Chnl'),charIDToTypeID('Msk '));
  var md=new ActionDescriptor();md.putReference(charIDToTypeID('null'),mr);executeAction(charIDToTypeID('slct'),md,DialogModes.NO);
 }else{
  var current=readTarget();
  if(current.method!=='getter'||!snapshotEqual(current.channels,original.channels))d.activeChannels=original.objects;
 }
}`;
}

export function nativeObserverScript(args) {
  return `
var step='init.app.activeDocument',d=app.activeDocument;
var actualDocumentId=d.id,actualLayerId=d.activeLayer.id;
if(${args.pure === true}){
 d=null;for(var i=0;i<app.documents.length;i++)if(app.documents[i].id===${args.document_id})d=app.documents[i];
 if(!d)throw new Error('DOCUMENT_NOT_REGISTERED');
}
${nativeTargetScript(args.mask_target)}
function snapshot(){
 var ref=new ActionReference();ref.putIdentifier(charIDToTypeID('Dcmn'),d.id);
 var has=executeActionGet(ref).hasKey(stringIDToTypeID('selection')),bounds=null;
 if(has){bounds=[];var b=d.selection.bounds;for(var i=0;i<4;i++)bounds.push(b[i].as('px'));}
 step='document.activeChannels.read';var target=readTarget(),components=[],componentRoster=[],channels=[],layers=[];
 for(var i=0;i<d.componentChannels.length;i++){var c=d.componentChannels[i];
  components.push(c.name);componentRoster.push({name:c.name,kind:String(c.kind),component:c.kind===ChannelType.COMPONENT});}
 var calibrated=d.mode===DocumentMode.RGB&&d.bitsPerChannel===BitsPerChannelType.EIGHT;
 if(!calibrated&&!${args.no_raw_pixels === true})throw new Error('NON_RGB_NO_RAW_CALIBRATION_REQUIRED');
 if(calibrated){${channelMetadataScript()}}
 else for(var i=0;i<d.channels.length;i++){
  var c=d.channels[i],metadata={index:i,name:c.name,kind:String(c.kind),visible:c.visible,histogram:null,
   histogramAvailability:{available:false,reason:'non-rgb-source-pixels-not-measured'}};
  if(c.kind!==ChannelType.COMPONENT){metadata.opacity=c.opacity;var rgb=c.color.rgb;metadata.color={r:rgb.red,g:rgb.green,b:rgb.blue};}
  channels.push(metadata);
 }
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
  layers.push({id:l.id,name:l.name,typename:l.typename,kind:String(l.kind),visible:l.visible,opacity:l.opacity,
   fillOpacity:l.fillOpacity,blendMode:String(l.blendMode),bounds:px,allLocked:l.allLocked,pixelsLocked:l.pixelsLocked,
   transparentPixelsLocked:l.transparentPixelsLocked,positionLocked:l.positionLocked,isBackgroundLayer:l.isBackgroundLayer,mask:mask});
 }
 var history=null;
 if(${args.history === true}){
  var hr=new ActionReference();hr.putEnumerated(charIDToTypeID('HstS'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));
  hr.putIdentifier(charIDToTypeID('Dcmn'),d.id);var hd=executeActionGet(hr),hk=stringIDToTypeID('ID');
  if(!hd.hasKey(hk))throw new Error('NATIVE_HISTORY_ID_GATE');
  history={id:hd.getInteger(hk),count:d.historyStates.length};
 }
 return {hasSelection:has,bounds:bounds,state:{mode:String(d.mode),depth:String(d.bitsPerChannel),quickMask:d.quickMaskMode,
  document:{id:d.id,name:d.name,width:d.width.as('px'),height:d.height.as('px'),resolution:d.resolution,saved:d.saved,pixelAspectRatio:d.pixelAspectRatio},
  channels:target.channels,target:targetState(target),allChannels:channels,components:components,componentRoster:componentRoster,layers:layers},
  history:history,active:{document_id:actualDocumentId,layer_id:actualLayerId}};
}
var copy=null,copyId=null,temporary=null,originalTarget=null,originalLayer=d.activeLayer;
var before=null,sameBefore=null,sameAfter=null,shape=[],counts=[],problem=null,cleanup=[],channelName=null;
try{
 step='document.size';if(d.width.as('px')!==8||d.height.as('px')!==8)throw new Error('OBSERVER_SIZE');
 step='prepare.document.activeChannels';originalTarget=readTarget();
 step='source.snapshot.before';before=snapshot();
 if(${args.pure === true})return before;
 if(before.hasSelection){
  step='source.channel.name';channelName='native-selection-probe';var suffix=0;
  function nameExists(name){for(var i=0;i<d.channels.length;i++)if(d.channels[i].name===name)return true;return false;}
  while(nameExists(channelName))channelName='native-selection-probe-'+(++suffix);
  step='source.channel.add';temporary=d.channels.add();temporary.name=channelName;
  temporary.kind=ChannelType.MASKEDAREA;if(temporary.kind!==ChannelType.MASKEDAREA)throw new Error('FIXED_MASKEDAREA_KIND_GATE');
  step='source.selection.store';d.selection.store(temporary,SelectionType.REPLACE);
  step='source.target.restore';restoreTarget(originalTarget);
  step='source.snapshot.same-structure-before';sameBefore=snapshot();
  step='duplicate';copy=d.duplicate('native-shape-probe',false);copyId=copy.id;if(copyId===d.id)throw new Error('COPY_OWNERSHIP_GATE');
  var a=null;for(var i=0;i<copy.channels.length;i++)if(copy.channels[i].name===channelName){if(a)throw new Error('NATIVE_ALPHA_DUPLICATE_GATE');a=copy.channels[i];}
  if(!a||a.kind!==ChannelType.MASKEDAREA)throw new Error('NATIVE_ALPHA_COPY_GATE');
  step='copy.alpha.target';copy.activeChannels=[a];
  step='copy.alpha.visible';if(!a.visible)a.visible=true;if(!a.visible)throw new Error('COPY_ALPHA_VISIBLE_GATE');
  copy.selection.deselect();
  for(var y=0;y<8;y++)for(var x=0;x<8;x++){
   step='copy.pixel.'+x+'.'+y;
   copy.selection.select([[UnitValue(x,'px'),UnitValue(y,'px')],[UnitValue(x+1,'px'),UnitValue(y,'px')],
    [UnitValue(x+1,'px'),UnitValue(y+1,'px')],[UnitValue(x,'px'),UnitValue(y+1,'px')]],SelectionType.REPLACE,0,false);
   var h=a.histogram;if(h.length!==256)throw new Error('HISTOGRAM_LENGTH_GATE');
   var count=0,value=0;for(var k=0;k<256;k++){count+=h[k];value+=k*h[k];}
   if(count!==1)throw new Error('NATIVE_SHAPE_HISTOGRAM_GATE');counts.push(count);shape.push(value);
  }
 }
}catch(e){problem={phase:step,message:String(e.message),number:e.number===undefined?null:e.number};}
if(${args.pure === true}){
 if(problem)throw new Error(problem.message+' [native_observe step='+problem.phase+']');
}
try{
 if(copy){step='cleanup.copy.close';copy.close(SaveOptions.DONOTSAVECHANGES);copy=null;cleanup.push('copy-closed');}
 step='cleanup.restore.activeDocument';app.activeDocument=d;
 step='cleanup.restore.activeLayer';if(d.activeLayer.id!==originalLayer.id)d.activeLayer=originalLayer;
 if(originalTarget){step='cleanup.restore.activeChannels';restoreTarget(originalTarget);}
 if(sameBefore){step='source.snapshot.same-structure-after';sameAfter=snapshot();}
 if(temporary){step='cleanup.source.channel.remove';temporary.remove();temporary=null;cleanup.push('alpha-removed');}
 if(originalTarget){step='cleanup.restore.originalChannels';restoreTarget(originalTarget);}
}catch(e){return {ok:false,cleanupFailed:true,error:{phase:step,message:String(e.message)},problem:problem,
 remaining:{copy_id:copy?copyId:null,source_id:d.id,temporary_channel:temporary?channelName:null},cleanup:cleanup};}
if(problem)return {ok:false,cleanupFailed:false,error:problem,cleanup:cleanup};
try{
 step='source.snapshot.after-cleanup';var after=snapshot();
 function invariant(o){return {hasSelection:o.hasSelection,bounds:o.bounds,state:o.state,active:o.active};}
 if(!snapshotEqual(invariant(after),invariant(before)))throw new Error('OBSERVER_SOURCE_STATE_RESTORE_GATE');
 if(sameBefore&&!snapshotEqual(invariant(sameAfter),invariant(sameBefore)))throw new Error('OBSERVER_SAME_STRUCTURE_GATE');
 return {ok:true,hasSelection:before.hasSelection,shape:shape,counts:counts,state:before.state,
  history:before.history,active:before.active,cleanup:cleanup,historyAfter:after.history};
}catch(e){return {ok:false,cleanupFailed:false,error:{phase:step,message:String(e.message)},cleanup:cleanup};}`;
}
