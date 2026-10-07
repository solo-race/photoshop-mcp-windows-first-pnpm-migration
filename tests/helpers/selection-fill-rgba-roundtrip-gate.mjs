import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { decodePNG } from './selection-fill-native-decoder.mjs';
import { preflightWriterLock } from './selection-fill-am-channel-gate.mjs';

export const PROJECT_ID = 'selection-fill-native';
export const TASK_ID = 'disposable-p2';
export const SOURCE_PATH = '.tmp/selection-fill-native/rgba-roundtrip/source.png';
export const EXPORT_PATH = '.tmp/selection-fill-native/rgba-roundtrip/export.png';
// Independent row-major RGBA literal. Transparent pixels retain [7,8,9].
const literal = [
  101,102,103,255, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 11,29,53,255,
];
export function expectedRGBA() { return Buffer.from(literal); }

// CRC is required by PNG, rather than an additional evidence fingerprint.
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createFixturePNG() {
  const rgba = expectedRGBA();
  assert.equal(rgba.length, 256);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(8 * 33); // Filter 0, then 32 literal RGBA bytes per row.
  for (let y = 0; y < 8; y++) rgba.copy(rows, y * 33 + 1, y * 32, (y + 1) * 32);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function compareRGBA(decoded) {
  const expected = expectedRGBA();
  if (decoded.width !== 8 || decoded.height !== 8 || decoded.rgba.length !== 256
    || !decoded.rgba.equals(expected)) throw new Error('RGBA_PIPELINE_NOT_PRESERVING');
  return { rgbaRoundtripGatePassed: true, scope: 'fixed-owned-import-document-export-sample',
    observerRepairAllowed: false };
}

// All three task additions are checked before the callback can write fixtures or use COM.
export async function withAuthorizedRoundtrip(projects, project, paths, execute) {
  await projects.unchanged();
  const source = join(project.root, SOURCE_PATH), destination = join(project.root, EXPORT_PATH);
  const failures = [];
  const check = (scope, action) => {
    try { action(); } catch (error) { failures.push({ scope, error: String(error) }); }
  };
  check('duplicate-tool/source-document', () => {
    const grant = projects.grant(project, TASK_ID, 'photoshop_duplicate_document', source);
    if (!grant.allow_new_documents) throw new Error('NEW_DOCUMENT_DENIED');
  });
  check('source-document', () => projects.grant(project, TASK_ID, 'photoshop_open_image', source));
  check('export-output', () => {
    const grant = projects.grant(project, TASK_ID, 'photoshop_export_document', undefined, true);
    if (!paths.matchesGrantedPath(project.root, grant.output_paths ?? [], destination))
      throw new Error('TASK_OUTPUT_DENIED');
  });
  check('existing-file-roots', () => {
    const allows = (roots, file) => roots.some(root => paths.inside(join(project.root, root), file));
    if (!allows(project.read_paths, source) || !allows(project.write_paths, source)
      || !allows(project.write_paths, destination)) throw new Error('PATH_DENIED');
  });
  check('existing-owned-cleanup', () => {
    projects.grant(project, TASK_ID, 'photoshop_close_document', source, false, true);
    projects.grant(project, TASK_ID, 'photoshop_close_document', undefined, true, true);
  });
  if (failures.length) {
    const error = new Error('ROUNDTRIP_GRANT_STOP');
    error.failures = failures;
    throw error;
  }
  return execute();
}

function resultValue(result) {
  if (result.isError) throw new Error('PUBLIC_TOOL_FAILED:' + JSON.stringify(result));
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  // photoshop_open_image is the existing legacy handler with a Result: JSON suffix.
  const marker = text.lastIndexOf('\nResult: ');
  return JSON.parse(marker < 0 ? text : text.slice(marker + '\nResult: '.length));
}

export async function closeOwned(owned, registry, record) {
  for (const id of [...owned].reverse()) {
    try {
      const result = await registry.execute('photoshop_close_document', {
        project_id: PROJECT_ID, task_id: TASK_ID, document_id: id, save: false,
      });
      if (result.isError) throw new Error(JSON.stringify(result));
      owned.delete(id);
      record('cleanup', { document_id: id, closed: true });
    } catch (error) {
      record('cleanup-STOP', { document_id: id, error: String(error), remaining: [...owned] });
      return false; // No retry, other document cleanup, recovery or lock deletion.
    }
  }
  return true;
}

async function requireAbsent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('FRESH_PATH_REQUIRED:' + path);
}

async function assertOwnedCopy({ connection, projects, project, owned, documentId,
  PhotoshopAPIFactory, toExtendScriptValue }) {
  if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
  const recheck = async () => {
    if (!owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
    await projects.unchanged();
    projects.grant(project, TASK_ID, 'photoshop_export_document', undefined, true);
  };
  await recheck();
  // A fixed read-only inspection, using the existing export grant and session operation lock.
  return connection.withScope({ documentId, recheck }, async () => {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    return api.executeScript(`var d=app.activeDocument;
if(d.id!==${toExtendScriptValue(documentId)})throw new Error('OWNED_ACTIVE_TARGET_CHANGED');
var saved=false;try{d.fullName;saved=true;}catch(unsaved){}
if(saved||d.width.as('px')!==8||d.height.as('px')!==8||d.mode!==DocumentMode.RGB||d.bitsPerChannel!==BitsPerChannelType.EIGHT)throw new Error('OWNED_UNSAVED_RGB8_GATE');
return {document_id:d.id,unsaved:true,width:8,height:8,mode:'RGB',depth:8};`, 15000);
  });
}

async function run() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = join(root, '.tmp', 'selection-fill-rgba-roundtrip-evidence');
  const files = join(root, '.tmp', 'selection-fill-native', 'rgba-roundtrip');
  const owned = new Set(), evidence = [];
  const record = (event, data) => evidence.push({ event, data });
  let prepared = false, registry, stage = 'preflight', status = 'STOP';
  try {
    const { ProjectPolicy, inside, matchesGrantedPath, samePath } = await import('../../dist/security/project-policy.js');
    const projects = await ProjectPolicy.load('D:/CodexProjects/.tmp/selection-fill-projects.json');
    const project = projects.get(PROJECT_ID);
    if (!samePath(root, project.root)) throw new Error('PROJECT_ROOT_MISMATCH');
    await withAuthorizedRoundtrip(projects, project, { inside, matchesGrantedPath }, async () => {
      await preflightWriterLock();
      await requireAbsent(out);
      await requireAbsent(files); // Fresh source/export directory; never overwrite existing data.
      await mkdir(out); prepared = true;
      await mkdir(files);
      stage = 'source-fixture';
      const png = createFixturePNG(), decoded = decodePNG(png);
      compareRGBA(decoded); // Source is checked against the independent literal before import.
      const source = await projects.resolve(project, SOURCE_PATH, 'write');
      await writeFile(source, png, { flag: 'wx' });
      record('source', { path: SOURCE_PATH, width: decoded.width, height: decoded.height,
        channels: decoded.channels, expectedRGBA: [...expectedRGBA()] });
      const [{ PhotoshopConnection }, { ToolPolicy }, { ToolRegistry }, { createDocumentTools },
        { createImagePlacementTools }, { createAdvancedTools }, { PhotoshopAPIFactory },
        { toExtendScriptValue }] = await Promise.all([
        import('../../dist/platform/connection.js'), import('../../dist/security/tool-policy.js'),
        import('../../dist/core/tool-registry.js'), import('../../dist/tools/document-tools.js'),
        import('../../dist/tools/image-placement-tools.js'), import('../../dist/tools/advanced-tools.js'),
        import('../../dist/api/photoshop-api.js'), import('../../dist/core/serializer.js'),
      ]);
      const connection = new PhotoshopConnection();
      registry = new ToolRegistry(new ToolPolicy(projects, connection));
      const names = new Set(['photoshop_open_image', 'photoshop_duplicate_document',
        'photoshop_export_document', 'photoshop_close_document']);
      for (const definition of [...createDocumentTools(connection), ...createImagePlacementTools(connection),
        ...createAdvancedTools(connection, (name, args) => registry.execute(name, args))])
        if (names.has(definition.tool.name)) registry.register(definition.tool.name, definition);
      const call = async (name, args, documentId) => {
        stage = name;
        if (documentId !== undefined && !owned.has(documentId)) throw new Error('UNOWNED_DOCUMENT');
        return resultValue(await registry.execute(name, { project_id: PROJECT_ID, task_id: TASK_ID,
          ...args, ...(documentId === undefined ? {} : { document_id: documentId }) }));
      };
      const opened = await call('photoshop_open_image', { filePath: SOURCE_PATH });
      assert.ok(Number.isInteger(opened.id) && opened.id > 0, 'SOURCE_ID_GATE');
      owned.add(opened.id);
      record('opened-owned-source', opened);
      const copy = await call('photoshop_duplicate_document', { newName: 'RGBA roundtrip owned copy' }, opened.id);
      assert.ok(Number.isInteger(copy.id) && copy.id > 0 && copy.id !== opened.id, 'COPY_ID_GATE');
      owned.add(copy.id);
      record('duplicated-owned-copy', copy);
      stage = 'unsaved-copy-guard';
      record('unsaved-copy-guard', await assertOwnedCopy({ connection, projects, project, owned,
        documentId: copy.id, PhotoshopAPIFactory, toExtendScriptValue }));
      await call('photoshop_export_document', { path: EXPORT_PATH, format: 'PNG' }, copy.id);
      stage = 'export-decode-and-compare';
      const actual = decodePNG(await readFile(join(project.root, EXPORT_PATH)));
      record('export-decoded', { path: EXPORT_PATH, width: actual.width, height: actual.height,
        channels: actual.channels, rgba: [...actual.rgba] });
      record('roundtrip-sample', compareRGBA(actual));
      status = 'BLOCKED'; // Even a faithful sample does not authorize observer repair.
      record('BLOCKED', { rgbaRoundtripGatePassed: true, observerRepairAllowed: false,
        pending: ['full64 selection shape and observation state/restore gate'] });
    });
  } catch (error) {
    status = 'STOP';
    record('STOP', { stage, error: String(error), grantFailures: error.failures ?? null,
      pipelineAttribution: 'none', rgbaRoundtripGatePassed: false, observerRepairAllowed: false });
  } finally {
    if (registry && !await closeOwned(owned, registry, record)) status = 'STOP';
    if (prepared) {
      try { await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' }); }
      catch (error) { status = 'STOP'; console.error('EVIDENCE_WRITE_STOP:' + String(error)); }
    }
    console.log(JSON.stringify({ status, evidence: prepared ? join(out, 'evidence.json') : null,
      ...(prepared ? {} : { events: evidence }), remainingOwned: [...owned], observerRepairAllowed: false }));
    process.exitCode = status === 'BLOCKED' ? 2 : 1;
  }
}

export async function main(args = process.argv.slice(2), execute = run) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log('Preparation only; default/help has no COM or writes. --run: one owned 8x8 literal RGBA import/duplicate/export sample, normal Windows permission only. Missing grants STOP before fixtures or COM; no policy changes. Fresh directories only; retain source/export bytes. Observer repair remains blocked.');
    return;
  }
  if (args.length !== 1 || args[0] !== '--run') throw new Error('Only --help or --run is accepted.');
  await execute();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
