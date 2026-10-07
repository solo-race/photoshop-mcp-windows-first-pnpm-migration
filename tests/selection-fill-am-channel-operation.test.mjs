import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightWriterLock, readUnscopedChannels } from './helpers/selection-fill-am-channel-gate.mjs';
import { PhotoshopConnection } from '../dist/platform/connection.js';
import { PhotoshopAPIFactory } from '../dist/api/photoshop-api.js';
import { toExtendScriptValue } from '../dist/core/serializer.js';
import { ToolRegistry } from '../dist/core/tool-registry.js';
import { OperationLock, operationContext } from '../dist/core/operation-lock.js';
import { ScriptExecutionError } from '../dist/platform/windows-executor.js';

// Only test-owned directories and a mocked executor; the native runner retains
// its real global lock path. No Photoshop detection, cscript or COM is invoked.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ps-am-operation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'lock');
  const connection = new PhotoshopConnection();
  connection.directLock = new OperationLock(directory);
  connection.detector = { detect: async () => ({ version: 'mock', path: '', isRunning: true }) };
  const control = { scripts: [], scopes: [], grants: [], documents: [{ id: 4086, path: null }],
    grantErrorAt: 0, channelError: null };
  const result = { active: { document_id: 4086, layer_id: 2 }, candidates: [], readOnly: true };
  connection.executor = {
    isPhotoshopRunning: async () => true,
    execute: async (script) => {
      assert.ok(operationContext.getStore());
      assert.equal(JSON.parse(await readFile(join(directory, 'state'), 'utf8')).state, 'pending');
      control.scripts.push(script);
      if (script.includes('var records = []')) return control.documents;
      if (script.includes('OWNED_ACTIVE_TARGET_CHANGED')) {
        if (control.channelError) throw control.channelError;
        return result;
      }
      return 'fixture-created';
    },
  };
  const withScope = connection.withScope.bind(connection);
  connection.withScope = async (scope, callback) => {
    control.scopes.push(scope);
    return withScope(scope, callback);
  };
  const projects = {
    unchanged: async () => {},
    documentPath: async (_project, path) => path,
    grant: (...args) => {
      control.grants.push(args);
      if (control.grantErrorAt === control.grants.length) throw new Error('TASK_TOOL_DENIED');
      return {};
    },
  };
  const owned = new Set([4086]);
  const project = { id: 'selection-fill-native' };
  const reader = () => readUnscopedChannels({ connection, projects, project, owned,
    documentId: 4086, layerId: 2, PhotoshopAPIFactory, toExtendScriptValue });
  const policy = { decorate: definition => definition, run: (definition, args) => definition.handler(args) };
  const registry = new ToolRegistry(policy, new OperationLock(directory));
  registry.register('photoshop_ping', {
    tool: { name: 'photoshop_ping', description: 'offline fixture', inputSchema: { type: 'object', properties: {} } },
    handler: async () => ({ content: [{ type: 'text', text: await connection.executeScript('registry-fixture') }] }),
  });
  return { directory, connection, control, result, projects, owned, reader, registry };
}

test('read-only preflight preserves every existing primary/recovery lock and creates nothing', async (t) => {
  const f = await fixture(t);
  await preflightWriterLock(f.directory);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
  for (const [suffix, pid, state] of [
    ['', String(process.pid), null], // live old startup lock with no state
    ['', '99999999', '{"state":"pending","owner":"fixture"}'],
    ['', 'unknown', 'untrusted'],
    ['.recovery', 'unknown', null],
  ]) {
    const path = f.directory + suffix;
    await mkdir(path);
    await writeFile(join(path, 'pid'), pid);
    if (state !== null) await writeFile(join(path, 'state'), state);
    const before = await readdir(path);
    await assert.rejects(preflightWriterLock(f.directory), /WRITER_LOCK_EXISTS/);
    assert.deepEqual(await readdir(path), before);
    assert.equal(await readFile(join(path, 'pid'), 'utf8'), pid);
    if (state !== null) assert.equal(await readFile(join(path, 'state'), 'utf8'), state);
    await rm(path, { recursive: true }); // only this test's fabricated directory
  }
});

test('registry and two unscoped pure reads acquire current operation locks without self-blocking', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.registry.execute('photoshop_ping', {})).content[0].text, 'fixture-created');
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
  assert.deepEqual(await f.reader(), f.result);
  assert.deepEqual(await f.reader(), f.result);
  assert.equal(f.control.scripts.length, 5); // registry, inspect+pure, inspect+pure
  assert.equal(f.control.scopes.length, 2);
  for (const scope of f.control.scopes) {
    assert.deepEqual(Object.keys(scope), ['recheck']);
    assert.equal(typeof scope.recheck, 'function');
  }
  for (const script of f.control.scripts.filter(s => s.includes('OWNED_ACTIVE_TARGET_CHANGED'))) {
    assert.match(script, /PHOTOSHOP_SESSION_CHANGED/);
    assert.match(script, /d\.id!==4086\|\|d\.activeLayer\.id!==2/);
    assert.doesNotMatch(script, /app\.activeDocument\s*=/);
    assert.doesNotMatch(script, /target\.activeLayer\s*=/);
  }
  assert.equal(f.control.grants.length, 4); // initial grant + locked dispatch recheck per pure
  for (const grant of f.control.grants)
    assert.deepEqual(grant, [{ id: 'selection-fill-native' }, 'disposable-p2', 'native_observe', undefined, true]);
  assert.equal(f.connection.isFaulted, false);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
});

test('unowned, missing document and initial/rechecked grants reject before channel dispatch', async (t) => {
  for (const mode of ['unowned', 'missing', 'initial-grant', 'rechecked-grant']) {
    const f = await fixture(t);
    if (mode === 'unowned') f.owned.clear();
    if (mode === 'missing') f.control.documents = [];
    if (mode === 'initial-grant') f.control.grantErrorAt = 1;
    if (mode === 'rechecked-grant') f.control.grantErrorAt = 2;
    await assert.rejects(f.reader(), mode === 'unowned' ? /UNOWNED_DOCUMENT/
      : mode === 'missing' ? /DOCUMENT_NOT_REGISTERED/ : /TASK_TOOL_DENIED/);
    assert.equal(f.control.scripts.length, mode === 'unowned' ? 0 : 1);
    assert.equal(f.connection.isFaulted, false);
    await assert.rejects(access(f.directory), { code: 'ENOENT' });
  }
});

test('unknown pure response preserves pending and blocks cleanup registry dispatch without resetting', async (t) => {
  const f = await fixture(t);
  const error = new ScriptExecutionError('AM_RESPONSE_LOST', 'unknown');
  f.control.channelError = error;
  await assert.rejects(f.reader(), actual => actual === error);
  assert.equal(f.connection.isFaulted, true);
  const before = await readFile(join(f.directory, 'state'), 'utf8');
  assert.equal(JSON.parse(before).state, 'pending');
  const calls = f.control.scripts.length;
  await assert.rejects(f.registry.execute('photoshop_ping', {}), /WRITER_LOCK_PENDING/);
  await assert.rejects(f.reader(), /SESSION_FAULTED/);
  await f.registry.stop();
  assert.equal(f.control.scripts.length, calls);
  assert.equal(await readFile(join(f.directory, 'state'), 'utf8'), before);
  await assert.rejects(preflightWriterLock(f.directory), /WRITER_LOCK_EXISTS/);
});
