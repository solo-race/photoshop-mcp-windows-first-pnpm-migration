import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { preflightWriterLock } from './selection-fill-am-channel-gate.mjs';

const help = 'Preparation only; default/help never imports Photoshop code or uses COM.\n--run: once-only known-target field discovery and mask restoration on ONE new owned 8x8 RGB8 mask fixture. Use normal Windows permission with Photoshop already open. Existing evidence/lock refuses. RGB/alpha first reads are observations, not independent expected identity. Exit 2 is BLOCKED pending RGB/alpha identity and full 64-pixel shape/RGBA. No observer repair is authorized.';

export async function main(args = process.argv.slice(2), execute = run) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(help);
    return;
  }
  if (args.length !== 1 || args[0] !== '--run') throw new Error('Only --help or --run is accepted.');
  await execute();
}

async function run() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = join(root, '.tmp', 'selection-fill-am-channel-calibration-evidence');
  const owned = new Set(), evidence = [];
  let prepared = false, registry, stage = 'preflight';
  const record = (event, data) => evidence.push({ event, data });
  const call = async (name, args = {}, documentId, layerId) => {
    stage = name + (args.operation ? ':' + args.operation : '');
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
    await preflightWriterLock(); // Refuse; never reclaim a lock or pending state.
    await mkdir(out); // Exclusive one-shot marker; retain it on every outcome.
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
    ]) if (names.has(definition.tool.name)) registry.register(definition.tool.name, definition);
    const fixtureDefinition = nativeTools(connection, owned).find(d => d.tool.name === 'native_fixture');
    // All mutations retain native_fixture's existing grant, binding and policy scope.
    registry.register('native_fixture', {
      tool: { ...fixtureDefinition.tool, inputSchema: { type: 'object',
        properties: { operation: { type: 'string', enum: ['fixture', 'rgb', 'mask', 'alpha'] } },
        required: ['operation'] } },
      handler: async args => {
        if (!owned.has(args.document_id)) throw new Error('UNOWNED_DOCUMENT');
        if (args.operation === 'fixture') return fixtureDefinition.handler({ ...args, variant: 'mask', opaque: true });
        const api = await new PhotoshopAPIFactory(connection).createAPI();
        const result = await api.executeScript(targetScript(toExtendScriptValue(args.document_id),
          toExtendScriptValue(args.layer_id), args.operation), 15000);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      },
    });
    const created = await call('photoshop_create_document', { width: 8, height: 8, resolution: 72, colorMode: 'RGB' });
    if (!Number.isInteger(created.id)) throw new Error('CREATED_ID_GATE');
    owned.add(created.id);
    const context = await call('photoshop_get_active_context', {}, created.id);
    if (!Number.isInteger(context.activeLayer?.id)) throw new Error('LAYER_ID_GATE');
    record('known-input', { operation: 'fixture', variant: 'mask', opaque: true, document_id: created.id });
    const fixture = await call('native_fixture', { operation: 'fixture' }, created.id, context.activeLayer.id);
    if (!Number.isInteger(fixture.layer_id)) throw new Error('FIXTURE_LAYER_GATE');
    record('fixture-output', { document_id: created.id, ...fixture, identityVerified: false });
    await discoverAndRestore({
      documentId: created.id, layerId: fixture.layer_id, record,
      read: label => {
        stage = label;
        return readActualChannel({ connection, projects, project, owned, documentId: created.id,
          layerId: fixture.layer_id, PhotoshopAPIFactory, toExtendScriptValue });
      },
      setTarget: operation => call('native_fixture', { operation }, created.id, fixture.layer_id),
    });
    record('BLOCKED', { identityVerified: false, observerRepairAllowed: false,
      maskSelectedFieldsRestored: true,
      pending: ['independent RGB/alpha identity', 'independent full 64-pixel selection shape and RGBA',
        'before/after full shape, RGBA and active-state equality'] });
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
          break; // No COM retry, recovery or lock cleanup after failure.
        }
      }
    } finally {
      if (prepared) await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
    }
    console.log(JSON.stringify({ status: process.exitCode === 2 ? 'BLOCKED' : 'STOP',
      evidence: prepared ? join(out, 'evidence.json') : null }));
  }
}

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

export async function readActualChannel({ connection, projects, project, owned,
  documentId, layerId, PhotoshopAPIFactory, toExtendScriptValue }) {
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
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
  // No target-selection scope: read actual current state under the connection operation lock.
  return connection.withScope({ recheck }, async () => {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
