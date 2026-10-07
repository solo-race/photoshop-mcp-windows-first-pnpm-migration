import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { preflightWriterLock } from './selection-fill-am-channel-gate.mjs';
import { selectedFields, actualChannelScript } from './selection-fill-am-channel-calibration.mjs';

const help = 'Preparation only; default/help never imports Photoshop code or uses COM. --run: one fresh owned 8x8 mask/alpha fixture, four known targets and one getter read per target. Normal Windows permission only; existing output/lock refuses. Getter errors record BLOCKED; mismatches or cleanup failures STOP. Observer repair remains blocked pending full64 shape/RGBA.';

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
  const out = join(root, '.tmp', 'selection-fill-channel-identity-gate-getter-first-evidence');
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
        properties: { operation: { type: 'string', enum: ['fixture', 'roster', 'all', 'single', 'two', 'mask', 'alpha'] } },
        required: ['operation'] } },
      handler: async args => {
        if (!owned.has(args.document_id)) throw new Error('UNOWNED_DOCUMENT');
        if (args.operation === 'fixture') return fixtureDefinition.handler({ ...args, variant: 'mask', opaque: true });
        const api = await new PhotoshopAPIFactory(connection).createAPI();
        const result = await api.executeScript(producerScript(toExtendScriptValue(args.document_id),
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
    const produce = async operation => {
      record('known-input', { operation, document_id: created.id, layer_id: fixture.layer_id });
      const output = await call('native_fixture', { operation }, created.id, fixture.layer_id);
      record('producer-output', { operation, output });
      return output;
    };
    const producer = await produce('roster');
    const result = await verifyKnownTargets({
      documentId: created.id, layerId: fixture.layer_id, roster: producer.roster, record,
      read: (label, getter) => {
        stage = label;
        return readIdentity({ connection, projects, project, owned, documentId: created.id,
          layerId: fixture.layer_id, PhotoshopAPIFactory, toExtendScriptValue, getter });
      },
      setTarget: produce,
    });
    record('BLOCKED', { ...result, pending: ['independent full64 selection shape/RGBA and before/after equality'] });
    process.exitCode = 2;
  } catch (error) {
    const blocked = error instanceof GetterBlocked;
    record(blocked ? 'BLOCKED' : 'STOP', { stage, error: String(error),
      ...(blocked ? { originalGetterError: error.originalError } : {}),
      channelIdentityGatePassed: false, identityVerified: false, observerRepairAllowed: false });
    process.exitCode = blocked ? 2 : 1;
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
  const { connection, projects, project, owned, documentId, layerId,
    PhotoshopAPIFactory, toExtendScriptValue } = options;
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
  return connection.withScope({ recheck }, async () => {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
