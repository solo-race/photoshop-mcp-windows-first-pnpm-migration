import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_RAW_REQUIREMENTS, pureStateProjection, atomicBracket } from './selection-fill-native-probe.mjs';
import { requireAbsent, cleanupOwnedAfterFailure } from './selection-fill-full-observation-gate.mjs';
import { preflightWriterLock } from './selection-fill-am-channel-gate.mjs';

const PROJECT = 'selection-fill-native', TASK = 'disposable-p2';
const POLICY = 'D:/CodexProjects/.tmp/selection-fill-projects.json';
export const EVIDENCE_PATH = '.tmp/selection-fill-native-no-raw-es3-gate-evidence';
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
function resultValue(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') ?? '';
  const payload = text.includes('Result: ') ? text.slice(text.lastIndexOf('Result: ') + 8) : text;
  return JSON.parse(payload);
}
export function readiness() {
  return { status: 'PREPARED', nativeValidated: false, variants: VARIANTS,
    evidence: EVIDENCE_PATH + '/evidence.json', requiredPerCase: NO_RAW_REQUIREMENTS,
    boundary: 'No original Gray/16 pixels or histograms measured; owned copy alpha only; no PNG export.',
    bracket: 'one outer native_observe registry operation; inner only-recheck scope; fixed action only' };
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
async function run() {
  const root = fileURLToPath(new URL('../../', import.meta.url)), out = join(root, EVIDENCE_PATH);
  const owned = new Set(), events = [], cases = [];
  let prepared = false, connection, registry, close, cleanupFailed = false, request, stage = 'preflight';
  let evidence = { gate: 'selection-fill-native-no-raw', status: 'STOP', matrixAllowed: false, cases };
  const record = (event, data) => events.push({ event, data });
  try {
    const { ProjectPolicy, samePath } = await import('../../dist/security/project-policy.js');
    const projects = await ProjectPolicy.load(POLICY), project = projects.get(PROJECT);
    assert.ok(samePath(root, project.root), 'PROJECT_ROOT_MISMATCH'); await projects.unchanged();
    for (const name of ['photoshop_create_document', 'photoshop_duplicate_document', 'native_fixture', 'native_points', 'native_observe'])
      projects.grant(project, TASK, name, undefined, true);
    projects.grant(project, TASK, 'photoshop_close_document', undefined, true, true);
    await requireAbsent(out); await preflightWriterLock();
    await mkdir(out); prepared = true;
    await writeFile(join(out, 'prepared.json'), JSON.stringify(readiness(), null, 2), { flag: 'wx' });
    const [{ PhotoshopConnection }, { ToolRegistry }, { ToolPolicy }, { createDocumentTools }, { createAdvancedTools },
      { nativeTools, nativePureRead }, { PhotoshopAPIFactory }] = await Promise.all([
      import('../../dist/platform/connection.js'), import('../../dist/core/tool-registry.js'),
      import('../../dist/security/tool-policy.js'), import('../../dist/tools/document-tools.js'),
      import('../../dist/tools/advanced-tools.js'),
      import('./selection-fill-native-tools.mjs'), import('../../dist/api/photoshop-api.js'),
    ]);
    connection = new PhotoshopConnection(); registry = new ToolRegistry(new ToolPolicy(projects, connection));
    const natives = nativeTools(connection, owned), observer = natives.find(row => row.tool.name === 'native_observe');
    const points = natives.find(row => row.tool.name === 'native_points');
    const checkFailure = error => { if (error.cleanupFailed) cleanupFailed = true; throw error; };
    const originalObserve = observer.handler;
    observer.handler = async args => { try { return await originalObserve(args); } catch (error) { return checkFailure(error); } };
    const fixedProducer = async (doc, action) => {
      assert.ok(owned.has(doc.id), 'UNOWNED_DOCUMENT');
      const api = await new PhotoshopAPIFactory(connection).createAPI();
      return api.executeScript(producerScript(doc, action));
    };
    registry.register('native_points', {
      tool: { ...points.tool, inputSchema: { ...points.tool.inputSchema,
        properties: { ...points.tool.inputSchema.properties, gate_action: { type: 'string' }, variant: { type: 'string' } } } },
      handler: args => args.gate_action ? fixedProducer({ id: args.document_id, layer: args.layer_id, variant: args.variant }, args.gate_action)
        .then(value => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] })) : points.handler(args),
    });
    registry.register('native_observe', {
      tool: { ...observer.tool, inputSchema: { ...observer.tool.inputSchema,
        properties: { ...observer.tool.inputSchema.properties, bracket: { type: 'boolean' } } } },
      handler: async args => {
        if (!args.bracket) return observer.handler(args);
        const current = request;
        assert.ok(current && current.doc.id === args.document_id, 'BRACKET_REQUEST_GATE');
        await connection.withScope({ recheck: current.recheck }, async () => {
          current.result = await atomicBracket(async () => resultValue(await observer.handler({
            document_id: current.doc.id, pure: true, history: true, no_raw_pixels: true,
          })), current.action ? () => fixedProducer(current.doc, current.action) : undefined);
        });
        return { structuredContent: { bracketComplete: true }, content: [{ type: 'text', text: '{"bracketComplete":true}' }] };
      },
    });
    registry.register('native_fixture', natives.find(row => row.tool.name === 'native_fixture'));
    registerNoRawDocumentTools(registry, connection, { createDocumentTools, createAdvancedTools });
    const call = async (name, args = {}, doc) => {
      stage = 'tool:' + name;
      try {
        const result = await registry.execute(name, { project_id: PROJECT, task_id: TASK, ...args,
          ...(doc ? { document_id: doc.id } : {}),
          ...(doc && name.startsWith('native_') ? { layer_id: doc.layer } : {}) });
        if (connection.isFaulted || cleanupFailed) throw new Error('SESSION_UNSAFE_STOP');
        if (result.isError) throw new Error('TOOL_FAILED:' + name + ':' + JSON.stringify(result));
        if (name === 'photoshop_close_document') return result;
        return resultValue(result);
      } catch (error) { return checkFailure(error); }
    };
    close = async doc => {
      assert.ok(owned.has(doc.id), 'UNOWNED_DOCUMENT');
      try { await call('photoshop_close_document', { save: false }, doc); }
      catch (error) { cleanupFailed = true; throw error; }
      owned.delete(doc.id); record('owned-close', { id: doc.id, closed: true });
    };
    const bracket = async (doc, action) => {
      const registered = (await connection.inspectDocuments()).find(row => row.id === doc.id);
      assert.ok(owned.has(doc.id) && registered, 'OWNED_REGISTERED_GATE');
      assert.ok(!registered.path, 'OWNED_UNSAVED_GATE');
      const recheck = async () => {
        assert.ok(owned.has(doc.id), 'UNOWNED_DOCUMENT'); await projects.unchanged();
        projects.grant(project, TASK, 'native_observe', undefined, true);
        if (action === 'black-write') projects.grant(project, TASK, 'native_points', undefined, true);
      };
      await recheck(); const current = { doc, action, recheck, result: null }; request = current;
      try { await call('native_observe', { bracket: true }, doc); }
      finally { request = undefined; }
      assert.ok(current.result, 'BRACKET_RESULT_REQUIRED'); return current.result;
    };
    const pure = async doc => {
      stage = 'pure:' + doc.variant;
      try { return resultValue(await nativePureRead(connection, owned, projects, doc.id, { no_raw_pixels: true })); }
      catch (error) { return checkFailure(error); }
    };
    const full = async (doc, shape) => {
      const before = await pure(doc);
      const observed = await call('native_observe', { history: true, no_raw_pixels: true }, doc);
      const after = await pure(doc);
      validateRestoration(before, observed, after, doc, shape);
      record('full-observation', { variant: doc.variant, shape, before, observed, after, sourceStateRestored: true });
      return observed;
    };
    for (const variant of VARIANTS) {
      stage = 'create:' + variant;
      const created = await call('photoshop_create_document', { width: 8, height: 8, resolution: 72, colorMode: 'RGB' });
      assert.ok(Number.isInteger(created.id) && created.id > 0 && !owned.has(created.id), 'NEW_OWNED_ID_GATE');
      owned.add(created.id);
      const doc = { id: created.id, variant };
      const context = await call('photoshop_get_active_context', {}, doc); doc.layer = context.activeLayer?.id;
      assert.ok(Number.isInteger(doc.layer), 'ACTIVE_LAYER_GATE');
      const fixture = await call('native_fixture', { variant, opaque: true }, doc);
      const active = await call('photoshop_get_active_context', {}, doc);
      assert.equal(active.activeLayer?.id, fixture.layer_id, 'FIXTURE_LAYER_GATE'); doc.layer = fixture.layer_id;
      await call('native_points', { gate_action: 'white-baseline', variant }, doc);
      await call('native_points', { shape: 'four' }, doc);
      const fourBefore = await full(doc, 'four');
      const stable = await bracket(doc); validateBracket(stable, doc, 'four', 'stable');
      record('pure-stability', { variant, bracket: stable });
      const noop = await bracket(doc, 'readonly'); validateBracket(noop, doc, 'four', 'readonly');
      record('readonly-action', { variant, bracket: noop });
      // Selection setup and full one-shape observation are outside the write bracket.
      await call('native_points', { shape: 'one' }, doc);
      const oneBefore = await full(doc, 'one');
      const write = await bracket(doc, 'black-write'); validateBracket(write, doc, 'one', 'black-write');
      record('actual-write', { variant, producer: 'white-full-baseline-to-black-one-pixel', bracket: write,
        originalPixelBytesMeasured: false });
      const oneAfter = await full(doc, 'one');
      assert.deepEqual(oneAfter.state, oneBefore.state, 'WRITE_ONE_SOURCE_STRUCTURE_GATE');
      await call('native_points', { shape: 'four' }, doc);
      const fourAfter = await full(doc, 'four');
      assert.deepEqual(fourAfter.state, fourBefore.state, 'FOUR_SOURCE_STRUCTURE_GATE');
      await close(doc);
      cases.push({ variant, pureStable: true, actionOnlyBracket: true, full64Shape: true,
        sourceStateRestored: true, ownedCleanupComplete: true, noOriginalPixelBytesMeasured: true, closed: true });
    }
    evidence = passEvidence(cases, [...owned]);
  } catch (error) {
    const primaryStage = stage;
    const cleanup = await cleanupOwnedAfterFailure({ owned, connection, registry, close, error, cleanupFailed });
    record('STOP', { stage: primaryStage, primaryError: String(error), completion: error.completion,
      observation: error.observation, cleanup, remainingOwned: [...owned] });
    evidence = { gate: 'selection-fill-native-no-raw', status: 'STOP', matrixAllowed: false, cases };
    process.exitCode = 1;
  } finally {
    if (prepared) await writeFile(join(out, 'evidence.json'), JSON.stringify({ ...evidence, events,
      remainingOwned: [...owned], readiness: readiness() }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: evidence.status, matrixAllowed: evidence.matrixAllowed,
      evidence: prepared ? join(out, 'evidence.json') : null }));
  }
}
export async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0])))
    console.log('Preparation only; default/help no COM. --readiness prints criteria. --run tester only: Gray/16 no-raw gate, fresh selection-fill-native-no-raw-es3-gate-evidence; no original histograms/pixels, no PNG export, no observer mode conversion. Failure STOP without unknown/cleanup-failure retry or pending recovery.');
  else if (args.length === 1 && args[0] === '--readiness') console.log(JSON.stringify(readiness(), null, 2));
  else if (args.length === 1 && args[0] === '--run') await run();
  else throw new Error('Use --help, --readiness, or --run');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
