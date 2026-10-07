import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import * as decoder from './selection-fill-native-decoder.mjs';
import { SOURCE_PATH, expectedRGBA } from './selection-fill-rgba-roundtrip-gate.mjs';
import { requireAbsent, cleanupOwnedAfterFailure } from './selection-fill-full-observation-gate.mjs';
import { preflightWriterLock } from './selection-fill-am-channel-gate.mjs';

const PROJECT = 'selection-fill-native', TASK = 'disposable-p2';
const POLICY = 'D:/CodexProjects/.tmp/selection-fill-projects.json';
const RELATIVE = '.tmp/selection-fill-native/';
export const EVIDENCE_PATH = RELATIVE + 'matrix-prepared-observer-evidence';
export const NO_RAW_GATE_PATH = '.tmp/selection-fill-native-no-raw-es3-gate-evidence/evidence.json';
export const COVERAGE = Object.freeze({ sequentialPoints: 8, selectionFills: 4, psdReopens: 4,
  rejections: 22, legalLayerFill: 1, canvasEdgeSelection: 1, rgbObserverChecks: 8,
  alphaObserverChecks: 2, noRawObserverChecks: 4 });
export const EXPORT_PATHS = Array.from({ length: 105 }, (_, i) => RELATIVE + String(i + 40).padStart(3, '0') + '.png');
export const PSD_PATHS = Array.from({ length: 4 }, (_, i) => RELATIVE + 'case-' + i + '.psd');
export const NO_RAW_REQUIREMENTS = Object.freeze(['pureStable', 'actionOnlyBracket', 'full64Shape',
  'sourceStateRestored', 'ownedCleanupComplete', 'noOriginalPixelBytesMeasured']);

// Strict projection preserves saved, mask metadata and channel availability.
// Positive allows only saved/histogram changes; PSD compares semantic identities.
export function pureStateProjection(observation, comparison = 'strict') {
  assert.ok(['strict', 'positive', 'psd'].includes(comparison), 'UNKNOWN_PROJECTION');
  const state = JSON.parse(JSON.stringify(observation.state));
  if (comparison !== 'strict') {
    for (const channel of state.allChannels) delete channel.histogram;
    if (state.target?.am) delete state.target.am.histogram;
    delete state.document.saved;
  }
  if (comparison === 'psd') {
    delete state.document.id; delete state.document.name;
    for (const layer of state.layers) delete layer.id;
    return { state };
  }
  const projected = { hasSelection: observation.hasSelection, state, active: observation.active };
  for (const field of ['bounds', 'shape', 'counts'])
    if (Object.hasOwn(observation, field)) projected[field] = observation[field];
  return projected;
}
export function requireNoRawGate(evidence) {
  assert.equal(evidence?.status, 'PASS', 'NO_RAW_GATE_REQUIRED');
  assert.equal(evidence.gate, 'selection-fill-native-no-raw', 'NO_RAW_GATE_REQUIRED');
  assert.equal(evidence.matrixAllowed, true, 'NO_RAW_GATE_REQUIRED');
  assert.deepEqual(evidence.cases?.map(row => row.variant).sort(), ['depth16', 'gray'], 'NO_RAW_GATE_CASES');
  for (const row of evidence.cases) for (const key of NO_RAW_REQUIREMENTS)
    assert.equal(row[key], true, 'NO_RAW_GATE_CRITERION:' + row.variant + ':' + key);
  return evidence;
}
export function readiness() {
  return { status: 'PREPARED', nativeValidated: false, coverage: COVERAGE,
    exports: { count: EXPORT_PATHS.length, first: EXPORT_PATHS[0], last: EXPORT_PATHS.at(-1) },
    psds: PSD_PATHS, evidence: EVIDENCE_PATH, dependency: NO_RAW_GATE_PATH,
    noRawGate: { gate: 'selection-fill-native-no-raw', status: 'PASS', matrixAllowed: true,
      variants: ['gray', 'depth16'], requiredPerCase: NO_RAW_REQUIREMENTS },
    bracket: 'outer native_observe registry operation; inner pure only rechecks',
    boundary: 'Gray/16 original pixel bytes are not measured; no P3 completion claim' };
}
export async function atomicBracket(read, action) {
  const before = await read(), result = action ? await action() : null, after = await read();
  return { before, result, after };
}
export function mismatchLayerPairs(first, second, replacedLayer) {
  assert.notEqual(first.id, second.id, 'DISTINCT_OWNED_DOCUMENTS');
  assert.equal(first.opaque, true, 'OPAQUE_MISMATCH_SETUP_REQUIRED');
  assert.equal(second.opaque, false, 'TRANSPARENT_MISMATCH_SOURCE_PRESERVED');
  assert.ok(Number.isInteger(first.layer) && Number.isInteger(second.layer), 'MISMATCH_LAYER_IDS_GATE');
  assert.notEqual(first.layer, replacedLayer, 'FIRST_LAYER_REPLACEMENT_GATE');
  // Each fixture has exactly one layer; the old first layer was removed by native_fixture.
  assert.notEqual(first.layer, second.layer, 'FOREIGN_LAYER_IDS_GATE');
  return [[first, second], [second, first]];
}
const errorText = result => result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
export async function captureRejectedAction(connection, definition, action, cleanupUnsafe = () => false) {
  const execute = connection.executeScript, handler = definition.handler;
  const scriptErrors = [];
  let result, error, handlerResult, unsafeFailure, didThrow = false;
  connection.executeScript = async function (...parameters) {
    let returned;
    try { returned = await execute.apply(this, parameters); }
    catch (failure) {
      scriptErrors.push(failure.message);
      if (failure.completion === 'unknown' || failure.cleanupFailed) unsafeFailure = failure;
      throw failure;
    }
    // The API unwraps this completed script rejection after executeScript returns.
    // Record its original reason here, then let the API handle the same envelope.
    if (returned && typeof returned === 'object' && returned.ok === false &&
      returned.error && typeof returned.error === 'object' && typeof returned.error.message === 'string')
      scriptErrors.push(returned.error.message);
    return returned;
  };
  definition.handler = async function (...parameters) {
    handlerResult = await handler.apply(this, parameters); return handlerResult;
  };
  try { result = await action(); }
  catch (failure) { error = failure; didThrow = true; }
  finally { connection.executeScript = execute; definition.handler = handler; }
  if (connection.isFaulted || unsafeFailure || error?.completion === 'unknown' || error?.cleanupFailed || cleanupUnsafe())
    throw unsafeFailure ?? error ?? new Error('REJECTION_SESSION_UNSAFE_STOP');
  return { result, error, didThrow, scriptErrors, handlerResult };
}
export function verifyRejection(captured, expected, label) {
  assert.ok(expected, 'MISSING_EXPECTED_REJECTION:' + label);
  const { result, error, didThrow, scriptErrors, handlerResult } = captured;
  let rejection, originalReason;
  if (didThrow) {
    if (!expected.throw || !(error instanceof Error) || error.message !== expected.throw) throw error;
    assert.equal(scriptErrors.length, 0, 'UNEXPECTED_SCRIPT_FAILURE:' + label);
    rejection = error.message;
  } else {
    assert.equal(expected.throw, undefined, 'EXPECTED_ARGUMENT_REJECTION:' + label);
    assert.equal(result.isError, true, 'EXPECTED_REJECTION:' + label);
    rejection = errorText(result);
    assert.equal(rejection, 'PHOTOSHOP_OPERATION_FAILED: inspect the selected document locally; no automatic retry or recovery performed.', 'UNEXPECTED_REJECTION_CODE:' + label);
    if (expected.script) {
      assert.equal(scriptErrors.length, 1, 'MISSING_OR_EXTRA_SCRIPT_FAILURE:' + label);
      originalReason = scriptErrors[0];
      assert.equal(originalReason, expected.script, 'UNEXPECTED_REJECTION_REASON:' + label);
    } else {
      assert.equal(scriptErrors.length, 0, 'UNEXPECTED_SCRIPT_FAILURE:' + label);
      assert.equal(handlerResult?.isError, true, 'EXPECTED_HANDLER_REJECTION:' + label);
      originalReason = errorText(handlerResult);
      assert.equal(originalReason, expected.handler, 'UNEXPECTED_REJECTION_REASON:' + label);
    }
  }
  return { rejection, originalReason };
}
export function maskRejectionReason(observation) {
  const target = observation.state.target;
  assert.equal(target.method, 'mask-AM', 'MASK_GETTER_CAUSE_GATE');
  assert.equal(target.getterError?.phase, 'activeChannels.getter', 'MASK_GETTER_CAUSE_GATE');
  assert.ok(target.getterError.message, 'MASK_GETTER_CAUSE_GATE');
  return 'Fill cannot verify RGB target: ' + target.getterError.message;
}
function resultValue(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = errorText(result) ?? '';
  const payload = text.includes('Result: ') ? text.slice(text.lastIndexOf('Result: ') + 8) : text;
  try { return JSON.parse(payload); } catch { throw new Error('NATIVE_RESULT_CONTRACT_GATE'); }
}
async function preflight(projects, project, root, out, matchesGrantedPath, samePath) {
  assert.ok(samePath(root, project.root), 'PROJECT_ROOT_MISMATCH');
  await projects.unchanged();
  const source = await projects.resolve(project, SOURCE_PATH, 'read');
  const input = decoder.decodePNG(await readFile(source));
  assert.equal(input.width, 8); assert.equal(input.height, 8);
  assert.deepEqual(input.rgba, expectedRGBA(), 'INDEPENDENT_SOURCE_RGBA_GATE');
  for (const name of ['photoshop_create_document', 'photoshop_duplicate_document', 'photoshop_select_rectangle',
    'photoshop_fill_layer', 'photoshop_save_document', 'photoshop_export_document', 'native_fixture', 'native_points', 'native_observe'])
    projects.grant(project, TASK, name, undefined, true);
  projects.grant(project, TASK, 'photoshop_close_document', undefined, true, true);
  for (const path of [source, ...PSD_PATHS.map(p => join(root, p))]) {
    projects.grant(project, TASK, 'photoshop_open_image', path);
    projects.grant(project, TASK, 'photoshop_close_document', path, false, true);
    projects.grant(project, TASK, 'native_observe', path);
    projects.grant(project, TASK, 'photoshop_export_document', path);
  }
  assert.equal(projects.grant(project, TASK, 'photoshop_duplicate_document', source).allow_new_documents, true, 'SOURCE_DUPLICATE_DENIED');
  for (const [paths, tool] of [[EXPORT_PATHS, 'photoshop_export_document'], [PSD_PATHS, 'photoshop_save_document']]) {
    const grant = projects.grant(project, TASK, tool, undefined, true);
    for (const path of paths) {
      const destination = await projects.resolve(project, path, 'write', false);
      assert.ok(matchesGrantedPath(root, grant.output_paths ?? [], destination), 'EXACT_OUTPUT_GRANT_REQUIRED:' + path);
      assert.equal(matchesGrantedPath(root, grant.overwrite_paths ?? [], destination), false, 'OVERWRITE_MUST_BE_FALSE');
      await requireAbsent(destination);
    }
  }
  // Missing independent gate refuses before evidence creation or any COM.
  const gate = requireNoRawGate(JSON.parse(await readFile(join(root, NO_RAW_GATE_PATH), 'utf8')));
  await requireAbsent(out); await preflightWriterLock();
  return { source, gate };
}
async function run() {
  const root = fileURLToPath(new URL('../../', import.meta.url)), out = join(root, EVIDENCE_PATH);
  const owned = new Set(), events = [];
  let prepared = false, connection, registry, close, cleanupFailed = false, requestedBracket;
  let slot = 0, stage = 'preflight', status = 'STOP';
  const record = (event, data) => events.push({ event, data });
  const value = resultValue;
  try {
    const { ProjectPolicy, matchesGrantedPath, samePath } = await import('../../dist/security/project-policy.js');
    const projects = await ProjectPolicy.load(POLICY), project = projects.get(PROJECT);
    const { source, gate } = await preflight(projects, project, root, out, matchesGrantedPath, samePath);
    await mkdir(out); prepared = true;
    await writeFile(join(out, 'prepared.json'), JSON.stringify(readiness(), null, 2), { flag: 'wx' });
    record('preflight', { source: SOURCE_PATH, exports: EXPORT_PATHS, psds: PSD_PATHS, noRawGate: gate });
    const [{ PhotoshopConnection }, { ToolPolicy }, { ToolRegistry }, { createDocumentTools },
      { createLayerTools }, { createSelectionTools }, { createImagePlacementTools },
      { createAdvancedTools }, { nativeTools, nativePureRead }] = await Promise.all([
      import('../../dist/platform/connection.js'), import('../../dist/security/tool-policy.js'),
      import('../../dist/core/tool-registry.js'), import('../../dist/tools/document-tools.js'),
      import('../../dist/tools/layer-tools.js'), import('../../dist/tools/selection-tools.js'),
      import('../../dist/tools/image-placement-tools.js'), import('../../dist/tools/advanced-tools.js'),
      import('./selection-fill-native-tools.mjs'),
    ]);
    connection = new PhotoshopConnection();
    registry = new ToolRegistry(new ToolPolicy(projects, connection));
    const natives = nativeTools(connection, owned), observer = natives.find(d => d.tool.name === 'native_observe');
    const names = new Set(['photoshop_create_document', 'photoshop_duplicate_document', 'photoshop_get_active_context',
      'photoshop_select_rectangle', 'photoshop_fill_layer', 'photoshop_export_document', 'photoshop_save_document',
      'photoshop_open_image', 'photoshop_close_document', 'native_fixture', 'native_points']);
    for (const definition of [...createDocumentTools(connection), ...createLayerTools(connection),
      ...createSelectionTools(connection), ...createImagePlacementTools(connection),
      ...createAdvancedTools(connection, (name, args) => registry.execute(name, args)), ...natives])
      if (names.has(definition.tool.name)) registry.register(definition.tool.name, definition);
    registry.register('native_observe', {
      tool: { ...observer.tool, inputSchema: { ...observer.tool.inputSchema,
        properties: { ...observer.tool.inputSchema.properties, bracket: { type: 'boolean' } } } },
      handler: async args => {
        if (!args.bracket) return observer.handler(args);
        const request = requestedBracket;
        assert.ok(request && request.doc.id === args.document_id, 'BRACKET_REQUEST_GATE');
        // Outer registry owns the operation frame. Inner pure scope has no IDs:
        // no target repair or inspector between reads; nested action keeps policy.
        await connection.withScope({ recheck: request.recheck }, async () => {
          request.result = await atomicBracket(async () => {
            const snapshots = [];
            for (const doc of request.docs) snapshots.push(value(await observer.handler({
              document_id: doc.id, pure: true, history: true,
              mask_target: doc.variant === 'mask', no_raw_pixels: doc.noRaw,
            })));
            return snapshots;
          }, request.action);
        });
        return { structuredContent: { bracketComplete: true },
          content: [{ type: 'text', text: '{"bracketComplete":true}' }] };
      },
    });
    const raw = async (name, args = {}, id, layer) => {
      stage = 'tool:' + name;
      if (id !== undefined && !owned.has(id)) throw new Error('UNOWNED_DOCUMENT');
      try { return await registry.execute(name, { project_id: PROJECT, task_id: TASK, ...args,
        ...(id === undefined ? {} : { document_id: id }), ...(layer === undefined ? {} : { layer_id: layer }) }); }
      catch (error) { if (error.cleanupFailed) cleanupFailed = true; throw error; }
    };
    const success = async (...args) => {
      const result = await raw(...args);
      if (result.isError) throw new Error('TOOL_FAILED:' + args[0] + ':' + JSON.stringify(result));
      return result;
    };
    const call = async (...args) => value(await success(...args));
    const remember = id => {
      assert.ok(Number.isInteger(id) && id > 0 && !owned.has(id), 'NEW_OWNED_ID_GATE');
      owned.add(id); return id;
    };
    close = async doc => {
      try { await success('photoshop_close_document', { save: false }, doc.id); }
      catch (error) { cleanupFailed = true; throw error; }
      owned.delete(doc.id); record('owned-close', { id: doc.id, closed: true });
    };
    const captureRejection = (...args) => captureRejectedAction(connection, registry.get(args[0]),
      () => raw(...args), () => cleanupFailed);
    const bracket = async (doc, action, docs = [doc]) => {
      // Prepare metadata outside the pure/action/pure bracket.
      const registered = await connection.inspectDocuments(), paths = [];
      for (const target of docs) {
        assert.ok(owned.has(target.id), 'UNOWNED_DOCUMENT');
        const document = registered.find(row => row.id === target.id);
        assert.ok(document, 'DOCUMENT_NOT_REGISTERED');
        paths.push(document.path ? await projects.documentPath(project, document.path) : undefined);
      }
      const recheck = async () => {
        await projects.unchanged();
        for (let i = 0; i < docs.length; i++) {
          assert.ok(owned.has(docs[i].id), 'UNOWNED_DOCUMENT');
          if (paths[i]) await projects.documentPath(project, paths[i]);
          projects.grant(project, TASK, 'native_observe', paths[i], !paths[i]);
        }
      };
      await recheck();
      const request = { doc, docs, recheck, action, result: null }; requestedBracket = request;
      try { await success('native_observe', { bracket: true }, doc.id, doc.layer); }
      finally { requestedBracket = undefined; }
      assert.ok(request.result, 'BRACKET_RESULT_GATE'); return request.result;
    };
    const output = async (path, name, doc) => {
      const destination = await projects.resolve(project, path, 'write', false);
      const registered = (await connection.inspectDocuments()).find(row => row.id === doc.id);
      assert.ok(registered && owned.has(doc.id), 'OWNED_OUTPUT_GATE');
      const documentPath = registered.path ? await projects.documentPath(project, registered.path) : undefined;
      const grant = projects.grant(project, TASK, name, documentPath, !documentPath);
      assert.ok(matchesGrantedPath(root, grant.output_paths ?? [], destination), 'EXACT_OUTPUT_GRANT_REQUIRED');
      assert.equal(matchesGrantedPath(root, grant.overwrite_paths ?? [], destination), false, 'OVERWRITE_MUST_BE_FALSE');
      await requireAbsent(destination); return destination;
    };
    await batch({ call, success, raw, value, owned, remember, record, close, captureRejection,
      bracket, source, root, output, stage: label => { stage = label; },
      pureRead: async doc => value(await nativePureRead(connection, owned, projects, doc.id,
        { mask_target: doc.variant === 'mask', no_raw_pixels: doc.noRaw })),
      snapshotPath: () => { assert.ok(EXPORT_PATHS[slot], 'EXPORT_BUDGET'); return EXPORT_PATHS[slot++]; } });
    assert.equal(slot, EXPORT_PATHS.length, 'EXACT_MATRIX_EXPORT_COUNT');
    assert.equal(owned.size, 0, 'OWNED_CLEANUP_GATE');
    status = 'PASS'; record('matrix', { status, coverage: COVERAGE, exports: slot, noRawOriginalPixelsMeasured: false, P3Complete: false });
  } catch (error) {
    const primaryStage = stage;
    const cleanup = await cleanupOwnedAfterFailure({ owned, connection, registry, close, error, cleanupFailed });
    record('STOP', { stage: primaryStage, primaryError: String(error), completion: error.completion, cleanup, remainingOwned: [...owned] });
    process.exitCode = 1;
  } finally {
    if (prepared) await writeFile(join(out, 'evidence.json'), JSON.stringify({ status, events,
      remainingOwned: [...owned], readiness: readiness() }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status, evidence: prepared ? join(out, 'evidence.json') : null }));
  }
}

async function acceptance(h) {
  const {call,success,captureRejection,owned,remember,record,decoder:d,create,observe,pure,points,pixels,snapshot,close,checkShape} = h;
  const color = {red:d.COLOR[0],green:d.COLOR[1],blue:d.COLOR[2]};
  const fill = (doc,scope) => call('photoshop_fill_layer',{...color,scope},doc.id,doc.layer);
  const expectedRejections = {
    'empty-selection': {script:'Selection scope requires a selection'},
    'layer-with-selection': {script:'Layer scope requires no selection'},
    'missing-scope': {throw:'MISSING_ARGUMENT: arguments.scope'},
    'invalid-scope': {throw:'INVALID_ARGUMENT: arguments.scope'},
    'fractional-RGB': {throw:'INVALID_ARGUMENT: arguments.red'},
    'nonfinite-RGB': {throw:'INVALID_ARGUMENT: arguments.red'},
    'range-RGB': {throw:'INVALID_ARGUMENT: arguments.red'},
    negative: {throw:'INVALID_ARGUMENT: arguments.left'},
    fraction: {throw:'INVALID_ARGUMENT: arguments.left'},
    nonfinite: {throw:'INVALID_ARGUMENT: arguments.right'},
    reverse: {handler:'Error creating selection: Rectangle must have finite integer edges with 0 <= left < right and 0 <= top < bottom'},
    degenerate: {handler:'Error creating selection: Rectangle must have finite integer edges with 0 <= left < right and 0 <= top < bottom'},
    outside: {script:'Rectangle must be nonempty and inside the canvas'},
    'owned-document-layer-mismatch': {script:'TARGET_LAYER_CHANGED'},
    locked: {script:'Fill requires an editable ordinary pixel layer'},
    text: {script:'Fill requires an editable ordinary pixel layer'},
    smartobject: {script:'Fill requires an editable ordinary pixel layer'},
    alpha: {script:'Fill requires all RGB color channels'},
    gray: {script:'Fill requires an RGB8 document'},
    depth16: {script:'Fill requires an RGB8 document'},
  };
  const reject = async (doc,name,args,label,layer=doc.layer,docs=[doc],reasonLabel=label) => {
    const capture = async () => {
      // End at the action target; no target repair between the two pure reads.
      const order=[...docs.filter(target=>target!==doc),doc],captured=new Map();
      for(const target of order) captured.set(target.id,await snapshot(target));
      return docs.map(target=>captured.get(target.id));
    };
    const before=await capture();
    const expected=reasonLabel==='mask'
      ? {script:maskRejectionReason(before[0].observation)} : expectedRejections[reasonLabel];
    const bracket=await h.bracket(doc,()=>captureRejection(name,args,doc.id,layer),docs);
    const reason=verifyRejection(bracket.result,expected,label);
    assert.deepEqual(bracket.after,bracket.before,'REJECTION_DIRECT_HISTORY_STATE_CHANGED:'+label);
    const after=await capture();
    for(let i=0;i<docs.length;i++){
      assert.deepEqual(pureStateProjection(after[i].observation),pureStateProjection(before[i].observation),'REJECTION_FULL_STATE_CHANGED:'+label);
      assert.deepEqual(after[i].rgba,before[i].rgba,'REJECTION_FULL_RGBA_CHANGED:'+label);
    }
    record(label,{rejected:true,unchanged:true,expected,...reason,
      bracketBoundary:'one registry operation frame; only tested action between pure reads',
      originalPixelBytesMeasured:!doc.noRaw,alphaPixelBytesDirectlyMeasured:false});
  };
  h.stage('selection-fill-and-PSD');
  for (const opaque of [false,true]) {
    const doc=await create('normal',opaque);
    let previous=await pixels(doc);
    assert.deepEqual(previous,doc.initialRGBA,'SEQUENTIAL_INITIAL_LITERAL_RGBA');
    for (const [x,y] of d.POINTS.four) {
      await success('photoshop_select_rectangle',
        {left:x,top:y,right:x+1,bottom:y+1},doc.id);
      const before=await snapshot(doc);
      assert.deepEqual(before.rgba,previous,'POINT_BEFORE_RGBA');
      assert.equal(before.observation.hasSelection,true);
      assert.deepEqual(before.observation.shape,
        Array.from({length:64},(_,i)=>i===y*8+x?255:0),'POINT_FULL_SELECTION');
      const result=await fill(doc,'selection');
      assert.deepEqual(result,{scope:'selection',actualbounds:[x,y,x+1,y+1],selection_preserved:true});
      const after=await snapshot(doc);
      assert.deepEqual(pureStateProjection(after.observation,'positive'),pureStateProjection(before.observation,'positive'),'POINT_SELECTION_AND_STRUCTURE_PRESERVED');
      const expected=d.expectedFill(before.rgba,[[x,y]]);
      assert.deepEqual(after.rgba,expected,'POINT_EXACT_RGB_ALPHA_AND_OUTSIDE_RGBA');
      previous=Buffer.from(after.rgba);
      record('sequential-point',{opaque,x,y,fullShapePreserved:true,outsideRGBAUnchanged:true});
    }
    await close(doc);
  }
  let psd=0;
  for(const opaque of [false,true]) for(const shape of ['one','four']) {
    const doc=await create('normal',opaque);
    await points(doc,shape);
    const before=await snapshot(doc);checkShape(before.observation,shape);
    assert.deepEqual(before.rgba,doc.initialRGBA,'FILL_INITIAL_LITERAL_RGBA');
    const result=await fill(doc,'selection');
    const bounds=shape==='one'?[2,3,3,4]:[1,1,7,7];
    assert.deepEqual(result,{scope:'selection',actualbounds:bounds,selection_preserved:true});
    const after=await snapshot(doc);
    assert.deepEqual(pureStateProjection(after.observation,'positive'),pureStateProjection(before.observation,'positive'),'FULL_SELECTION_AND_STRUCTURE_PRESERVED');
    const expected=d.expectedFill(before.rgba,d.POINTS[shape]);
    assert.deepEqual(after.rgba,expected,'EXACT_RGB_ALPHA_AND_OUTSIDE_RGBA');
    record('fill-'+opaque+'-'+shape,{bounds,expectedRGBA:Array.from(expected),outsideRGBAUnchanged:true,fullShapePreserved:true});
    const semanticState=pureStateProjection(await pure(doc),'psd');
    const path=PSD_PATHS[psd++];
    await h.output(path,'photoshop_save_document',doc);
    await success('photoshop_save_document',{path,format:'PSD'},doc.id);
    await close(doc);
    const opened=await call('photoshop_open_image',{filePath:path});
    assert.ok(Number.isInteger(opened.id),'REOPEN_ID_GATE');
    remember(opened.id);
    const context=await call('photoshop_get_active_context',{},opened.id);
    const reopened={...doc,id:opened.id,layer:context.activeLayer?.id};
    assert.ok(Number.isInteger(reopened.layer),'REOPEN_LAYER_GATE');
    assert.deepEqual(await pixels(reopened),after.rgba,'PSD_REOPEN_RGBA');
    assert.deepEqual(pureStateProjection(await pure(reopened),'psd'),semanticState,'PSD_REOPEN_SEMANTIC_STATE');
    record('PSD-'+path,{pixelAndLayerStatePreserved:true,selectionPersistenceNotAssumed:true});
    await close(reopened);
  }
  h.stage('prewrite-rejections');
  const doc=await create('normal',true);
  await reject(doc,'photoshop_fill_layer',{...color,scope:'selection'},'empty-selection');
  await points(doc,'four');
  await reject(doc,'photoshop_fill_layer',{...color,scope:'layer'},'layer-with-selection');
  for(const [label,args] of [
    ['missing-scope',color],['invalid-scope',{...color,scope:'bad'}],
    ['fractional-RGB',{...color,scope:'selection',red:0.5}],
    ['nonfinite-RGB',{...color,scope:'selection',red:Infinity}],
    ['range-RGB',{...color,scope:'selection',red:256}]
  ]) await reject(doc,'photoshop_fill_layer',args,label);
  for(const [label,rect] of [
    ['negative',[-1,0,1,1]],['fraction',[0.5,0,1,1]],['nonfinite',[0,0,Infinity,1]],
    ['reverse',[3,0,2,1]],['degenerate',[2,0,2,1]],['outside',[0,0,9,8]]
  ]) await reject(doc,'photoshop_select_rectangle',
    {left:rect[0],top:rect[1],right:rect[2],bottom:rect[3]},label);
  await close(doc);
  const first=await create('normal',true);
  const second=await create('normal',false);
  assert.notEqual(first.id,second.id,'DISTINCT_OWNED_DOCUMENTS');
  const replacedLayer=first.layer;
  const replacement=await call('native_fixture',{variant:'normal',opaque:true},first.id,first.layer);
  const context=await call('photoshop_get_active_context',{},first.id);
  assert.ok(Number.isInteger(context.activeLayer?.id),'MISMATCH_ACTIVE_LAYER_ID_GATE');
  assert.equal(context.activeLayer.id,replacement.layer_id,'MISMATCH_FIXTURE_LAYER_GATE');
  first.layer=context.activeLayer.id;
  const mismatchPairs=mismatchLayerPairs(first,second,replacedLayer);
  await points(first,'one');
  await points(second,'four');
  for(const [target,foreign] of mismatchPairs)
    await reject(target,'photoshop_fill_layer',{...color,scope:'selection'},
      'owned-document-layer-mismatch-'+target.id,foreign.layer,[first,second],'owned-document-layer-mismatch');
  await close(first);await close(second);
  for(const variant of ['locked','text','smartobject','alpha','mask','gray','depth16']) {
    const target=await create(variant,true),selected=['alpha','gray','depth16'].includes(variant);
    if(selected){await points(target,'four');await h.calibrateObserver(target,'four');}
    await reject(target,'photoshop_fill_layer',{...color,scope:selected?'selection':'layer'},variant);
    await close(target);
  }
  h.stage('legal-layer-and-canvas-edge');
  const layer=await create('normal',false),before=await snapshot(layer);
  checkShape(before.observation,'none');
  assert.deepEqual(before.rgba,layer.initialRGBA,'LAYER_INITIAL_LITERAL_RGBA');
  const result=await fill(layer,'layer');
  assert.deepEqual(result,{scope:'layer',actualbounds:[0,0,8,8],selection_preserved:true});
  const after=await snapshot(layer);checkShape(after.observation,'none');
  assert.deepEqual(pureStateProjection(after.observation,'positive'),pureStateProjection(before.observation,'positive'),'LAYER_STRUCTURE_PRESERVED');
  assert.deepEqual(after.rgba,Buffer.from(Array(64).fill(d.COLOR).flat()),'LAYER_FULL_RGBA');
  await success('photoshop_select_rectangle',{left:7,top:7,right:8,bottom:8},layer.id);
  const edge=await snapshot(layer);
  assert.equal(edge.observation.hasSelection,true);
  assert.deepEqual(edge.observation.shape,Array.from({length:64},(_,i)=>i===63?255:0),'HALF_OPEN_EDGE_GATE');
  assert.deepEqual(edge.observation.counts,Array(64).fill(1),'EDGE_HISTOGRAM_COUNT');
  assert.deepEqual(edge.rgba,after.rgba,'EDGE_SELECTION_NO_PIXEL_CHANGE');
  record('layer-and-edge',{wholeLayerRGBA:true,noSelectionRestored:true,halfOpenEdge:true});
  await close(layer);
}

async function batch(h) {
  const {call,success,remember,record,close}=h, d=decoder;
  const context=async id=>{
    const result=await call('photoshop_get_active_context',{},id);
    assert.ok(Number.isInteger(result.activeLayer?.id),'ACTIVE_LAYER_ID_GATE');
    return result.activeLayer.id;
  };
  const create=async (variant='normal',opaque=false)=>{
    let id,layer;
    if(!opaque){
      assert.equal(variant,'normal','TRANSPARENT_LITERAL_FIXTURE_ONLY');
      const opened=await call('photoshop_open_image',{filePath:SOURCE_PATH});
      const sourceId=remember(opened.id);
      const duplicate=await call('photoshop_duplicate_document',{newName:'native-transparent-owned'},sourceId);
      id=remember(duplicate.id);assert.notEqual(id,sourceId,'DUPLICATE_OWNERSHIP_GATE');
      await close({id:sourceId});
      layer=await context(id); // Preserve producer layer and hidden RGB.
    }else{
      const result=await call('photoshop_create_document',{width:8,height:8,resolution:72,colorMode:'RGB'});
      id=remember(result.id);layer=await context(id);
      const fixture=await call('native_fixture',{variant,opaque:true},id,layer);
      layer=await context(id);assert.equal(layer,fixture.layer_id,'FIXTURE_LAYER_GATE');
    }
    return {id,layer,variant,opaque,noRaw:['gray','depth16'].includes(variant),
      initialRGBA:opaque?d.expectedBackground(true):expectedRGBA()};
  };
  const observe=doc=>call('native_observe',{mask_target:doc.variant==='mask',no_raw_pixels:doc.noRaw},doc.id,doc.layer);
  const pure=doc=>h.pureRead(doc);
  const points=(doc,shape)=>call('native_points',{shape},doc.id,doc.layer);
  const pixels=async doc=>{
    assert.equal(doc.noRaw,false,'NON_RGB_ORIGINAL_PIXEL_BYTES_NOT_MEASURED');
    const path=h.snapshotPath(),destination=await h.output(path,'photoshop_export_document',doc);
    await success('photoshop_export_document',{path,format:'PNG'},doc.id);
    const decoded=d.decodePNG(await readFile(destination));
    assert.equal(decoded.width,8);assert.equal(decoded.height,8);
    record('actual-export',{document_id:doc.id,path,rgba:[...decoded.rgba]});
    return decoded.rgba;
  };
  const snapshot=async doc=>({observation:await observe(doc),rgba:doc.noRaw?null:await pixels(doc)});
  const mask=shape=>Array.from({length:64},(_,i)=>
    (d.POINTS[shape]??[]).some(([x,y])=>i===y*8+x)?255:0);
  const checkShape=(o,shape)=>{
    assert.equal(o.hasSelection,shape!=='none','SELECTION_PRESENCE_GATE');
    assert.deepEqual(o.shape,shape==='none'?[]:mask(shape),'FULL_RAW_SHAPE_GATE');
    assert.deepEqual(o.counts,shape==='none'?[]:Array(64).fill(1),'FULL_HISTOGRAM_COUNT_GATE');
  };
  const calibrateObserver=async (doc,shape)=>{
    for(let iteration=0;iteration<2;iteration++){
      const rgba=doc.noRaw?null:await pixels(doc),original=await pure(doc);
      assert.deepEqual(original.active,{document_id:doc.id,layer_id:doc.layer},'OBSERVER_ACTIVE_GATE');
      const stable=await h.bracket(doc);
      assert.deepEqual(stable.after,stable.before,'PURE_READ_STABILITY_GATE');
      const observation=await observe(doc); // No cleanup probe after a failed/unknown observer.
      const after=await pure(doc);
      assert.deepEqual(pureStateProjection(after),pureStateProjection(original),'OBSERVER_SOURCE_STATE_CLEANUP_GATE');
      assert.deepEqual(observation.state,original.state,'OBSERVER_REPORTED_SOURCE_STATE_GATE');
      checkShape(observation,shape);
      if(!doc.noRaw)assert.deepEqual(await pixels(doc),rgba,'OBSERVER_SOURCE_FULL_RGBA_GATE');
      record('observer-cleanup',{document_id:doc.id,iteration,shape,noRaw:doc.noRaw,
        historyBefore:original.history,historyAfter:after.history,statePreserved:true});
    }
  };
  const colors=o=>o.state.target.method==='getter'&&o.state.channels.length===3&&
    o.state.channels.every(c=>/COMPONENT/.test(c.kind))&&
    o.state.channels.map(c=>c.name).sort().join('|')===o.state.components.slice().sort().join('|');
  h.stage('native-channel-mask-shape-export-gates');
  for(const opaque of [false,true]){
    const doc=await create('normal',opaque),observation=await observe(doc);
    assert.ok(colors(observation),'COMPONENT_TARGET_GATE');
    assert.match(observation.state.mode,/RGB/);assert.match(observation.state.depth,/EIGHT/);
    checkShape(observation,'none');
    assert.deepEqual(await pixels(doc),doc.initialRGBA,'INDEPENDENT_FIXTURE_RGBA_GATE');
    // Setup/export stay outside brackets; real calibration changes one pixel.
    await points(doc,'one');
    const rgbaBefore=await pixels(doc),stable=await h.bracket(doc);
    assert.deepEqual(stable.after,stable.before,'PURE_READ_STABILITY_GATE');
    const written=await h.bracket(doc,()=>call('native_points',{shape:'calibrate'},doc.id,doc.layer));
    assert.notEqual(written.after[0].history.id,written.before[0].history.id,'REAL_PIXEL_WRITE_HISTORY_GATE');
    assert.deepEqual(pureStateProjection(written.after[0],'positive'),pureStateProjection(written.before[0],'positive'),'WRITE_STRUCTURE_GATE');
    assert.deepEqual(await pixels(doc),d.expectedFill(rgbaBefore,d.POINTS.one,[11,29,53,255]),'FIXED_ONE_PIXEL_RGBA_GATE');
    for(const shape of ['one','four']){await points(doc,shape);await calibrateObserver(doc,shape);}
    await close(doc);
  }
  for(const variant of ['alpha','mask']){
    const doc=await create(variant,true),current=await snapshot(doc);
    assert.ok(!colors(current.observation),variant+'_TARGET_IDENTITY_GATE');
    if(variant==='mask')maskRejectionReason(current.observation);
    else assert.equal(current.observation.state.target.method,'getter','ALPHA_GETTER_GATE');
    assert.deepEqual(current.rgba,doc.initialRGBA,'CHANNEL_FIXTURE_FULL_RGBA_GATE');
    await close(doc);
  }
  await acceptance({...h,decoder:d,create,observe,pure,points,pixels,snapshot,close,mask,checkShape,calibrateObserver});
}

export async function main(args=process.argv.slice(2)){
  if(!args.length||(args.length===1&&['--help','-h'].includes(args[0]))){
    console.log('Preparation only; default/help never imports Photoshop code or uses COM.\n--readiness: matrix counts and independent no-raw gate requirements only.\n--verify-decoder: independent offline fixtures only.\n--run: tester only, after Gray/16 independent no-raw PASS; fresh matrix-prepared-observer-evidence, exact PNG040..144 and case-0..3.psd absent/authorized before COM. Internal registry/direct operation lock; existing primary/recovery refuses, never reclaimed. Failure STOP, no unknown/cleanup-failure retry.');
  }else if(args.length===1&&args[0]==='--readiness'){
    console.log(JSON.stringify(readiness(),null,2));
  }else if(args.length===1&&args[0]==='--verify-decoder'){
    console.log(decoder.verifyDecoderFixtures());
  }else if(args.length===1&&args[0]==='--run'){
    await run();
  }else{console.error('Only --help, --readiness, --verify-decoder or --run is accepted.');process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
