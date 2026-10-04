import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ToolRegistry } from '../dist/core/tool-registry.js';
import { OperationLock, operationContext } from '../dist/core/operation-lock.js';
import { ToolPolicy } from '../dist/security/tool-policy.js';
import { createAdvancedTools } from '../dist/tools/advanced-tools.js';
import { PhotoshopConnection } from '../dist/platform/connection.js';
import { WindowsExecutor, ScriptExecutionError } from '../dist/platform/windows-executor.js';
import { PhotoshopMCPServer } from '../dist/core/server.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const text = (value = 'ok') => ({ content: [{ type: 'text', text: value }] });
const definition = (name, handler) => ({
  tool: { name, description: name, inputSchema: { type: 'object', properties: {} } }, handler,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ps-registry-operation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'operation');
  const lock = new OperationLock(directory);
  const events = [];
  const grants = [];
  const assertLocked = async () => {
    assert.equal(operationContext.getStore()?.lock, lock);
    assert.equal((JSON.parse(await readFile(join(directory, 'state'), 'utf8'))).state, 'idle');
    assert.equal(await readFile(join(directory, 'pid'), 'utf8'), String(process.pid));
  };
  const projects = {
    unchanged: async () => { events.push('policy'); },
    get: () => ({ id: 'project', root }),
    documentPath: async (_project, path) => path,
    grant: (_project, task, name) => { grants.push({ task, name }); return {}; },
  };
  const connection = {
    inspectDocuments: async () => {
      await assertLocked(); events.push('inspect');
      return [{ id: 7, path: join(root, 'document.psd') }];
    },
    withScope: async (_scope, operation) => operation(),
  };
  const policy = new ToolPolicy(projects, connection);
  const registry = new ToolRegistry(policy, lock);
  return { root, directory, lock, registry, policy, projects, connection, events, grants, assertLocked };
}

test('lock precedes the complete policy.run, including policy metadata and inspectDocuments', async (t) => {
  const f = await fixture(t);
  f.projects.unchanged = async () => { await f.assertLocked(); f.events.push('policy'); };
  f.registry.register('photoshop_get_state', definition('photoshop_get_state', async () => {
    await f.assertLocked(); f.events.push('handler'); return text();
  }));
  await f.registry.execute('photoshop_get_state', { project_id: 'project', document_id: 7 });
  assert.deepEqual(f.events, ['policy', 'inspect', 'handler']);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
});

test('whole actual sequence shares one lock, nested grants apply, local calls wait and another registry is busy', async (t) => {
  const f = await fixture(t);
  const entered = deferred(), resume = deferred();
  let acquisitions = 0, writes = 0;
  const acquire = f.lock.acquire.bind(f.lock);
  f.lock.acquire = async () => { acquisitions++; await acquire(); };
  f.registry.register('photoshop_rename_layer', definition('photoshop_rename_layer', async () => {
    await f.assertLocked(); f.events.push('write' + ++writes);
    if (writes === 1) { entered.resolve(); await resume.promise; }
    return text();
  }));
  const sequence = createAdvancedTools(f.connection, (name, args) => f.registry.execute(name, args))
    .find((tool) => tool.tool.name === 'photoshop_run_sequence');
  f.registry.register(sequence.tool.name, sequence);
  f.registry.register('photoshop_ping', definition('photoshop_ping', async () => {
    await f.assertLocked(); f.events.push('ping'); return text();
  }));
  const call = f.registry.execute('photoshop_run_sequence', {
    project_id: 'project', task_id: 'task', steps: [1, 2].map(() => ({
      tool: 'photoshop_rename_layer', args: { document_id: 7, layer_id: 8 },
    })),
  });
  await entered.promise;
  assert.equal(acquisitions, 1);
  const queued = f.registry.execute('photoshop_ping', {});
  const other = new ToolRegistry(f.policy, new OperationLock(f.directory));
  other.register('photoshop_ping', definition('photoshop_ping', async () => assert.fail('busy handler')));
  const before = [...f.events];
  await assert.rejects(other.execute('photoshop_ping', {}), /WRITER_LOCK_ACTIVE/);
  assert.deepEqual(f.events, before);
  resume.resolve();
  await Promise.all([call, queued]);
  assert.equal(acquisitions, 2);
  assert.deepEqual(f.events.filter((event) => /write|ping/.test(event)), ['write1', 'write2', 'ping']);
  assert.deepEqual(f.grants, [1, 2].map(() => ({ task: 'task', name: 'photoshop_rename_layer' })));
  f.projects.grant = () => { throw new Error('TASK_TOOL_DENIED'); };
  await assert.rejects(f.registry.execute('photoshop_run_sequence', {
    project_id: 'project', task_id: 'task', steps: [{
      tool: 'photoshop_rename_layer', args: { document_id: 7, layer_id: 8 },
    }],
  }), /TASK_TOOL_DENIED/);
  assert.equal(writes, 2);
});

test('capabilities alone bypasses the Photoshop lock while preserving policy.run', async (t) => {
  const f = await fixture(t);
  await f.lock.acquire();
  const other = new ToolRegistry(f.policy, new OperationLock(f.directory));
  for (const name of ['photoshop_get_capabilities', 'photoshop_ping', 'photoshop_get_version'])
    other.register(name, definition(name, async () => text(name)));
  assert.equal((await other.execute('photoshop_get_capabilities', {})).content[0].text, 'photoshop_get_capabilities');
  for (const name of ['photoshop_ping', 'photoshop_get_version'])
    await assert.rejects(other.execute(name, {}), /WRITER_LOCK_ACTIVE/);
  assert.deepEqual(f.events, ['policy']);
  await f.lock.release();
});

test('shared stop drains queued promises with SERVER_STOPPING and waits for active before releasing', async (t) => {
  const f = await fixture(t);
  const entered = deferred(), resume = deferred();
  let calls = 0;
  f.registry.register('photoshop_ping', definition('photoshop_ping', async () => {
    calls++; entered.resolve(); await resume.promise;
    assert.equal(operationContext.getStore().isStopping(), true);
    return text();
  }));
  const active = f.registry.execute('photoshop_ping', {});
  await entered.promise;
  const queued1 = assert.rejects(f.registry.execute('photoshop_ping', {}), /SERVER_STOPPING/);
  const queued2 = assert.rejects(f.registry.execute('photoshop_ping', {}), /SERVER_STOPPING/);
  const stopped = f.registry.stop();
  assert.equal(f.registry.stop(), stopped);
  await Promise.all([queued1, queued2]);
  await assert.rejects(f.registry.execute('photoshop_ping', {}), /SERVER_STOPPING/);
  let finished = false;
  void stopped.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  await access(f.directory);
  assert.equal(calls, 1);
  resume.resolve();
  await Promise.all([active, stopped]);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
});

test('stop after Windows file preparation prevents spawn and settles pending as not-started', async (t) => {
  const f = await fixture(t);
  const prepared = deferred(), resume = deferred();
  t.after(() => resume.resolve());
  const connection = new PhotoshopConnection();
  const executor = new WindowsExecutor();
  connection.detector = { detect: async () => ({ version: 'mock', path: '', isRunning: true }) };
  connection.executor = executor;
  executor.isPhotoshopRunning = async () => true;
  let spawns = 0, scriptDirectory;
  executor.spawnScriptProcess = () => {
    spawns++;
    assert.fail('stop must prevent spawning the dispatch process');
  };
  const run = executor.runVbsScript.bind(executor);
  executor.runVbsScript = async (vbsPath, timeout, isStopping) => {
    scriptDirectory = dirname(vbsPath);
    assert.equal(await readFile(join(scriptDirectory, 'operation.jsx'), 'utf8'), 'mock script');
    assert.match(await readFile(vbsPath, 'utf8'), /DoJavaScriptFile/);
    assert.equal(isStopping(), false);
    prepared.resolve();
    await resume.promise;
    return await run(vbsPath, timeout, isStopping);
  };
  const completions = [];
  const complete = f.lock.completeDispatch.bind(f.lock);
  f.lock.completeDispatch = async (completion) => {
    completions.push(completion);
    await complete(completion);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'state'), 'utf8')).state, 'idle');
  };
  f.registry.register('photoshop_ping', definition('photoshop_ping', async () => {
    await connection.executeScript('mock script');
    return text();
  }));
  const active = f.registry.execute('photoshop_ping', {});
  await Promise.race([
    prepared.promise,
    active.then(() => assert.fail('dispatch must pause before spawning')),
  ]);
  const rejected = assert.rejects(active, (error) => {
    assert.ok(error instanceof ScriptExecutionError);
    assert.equal(error.message, 'SERVER_STOPPING');
    assert.equal(error.completion, 'not-started');
    return true;
  });
  const stopped = f.registry.stop();
  let drained = false;
  void stopped.then(() => { drained = true; });
  assert.equal(JSON.parse(await readFile(join(f.directory, 'state'), 'utf8')).state, 'pending');
  assert.equal(drained, false);
  assert.equal(spawns, 0);
  resume.resolve();
  await Promise.all([rejected, stopped]);
  assert.equal(spawns, 0);
  assert.deepEqual(completions, ['not-started']);
  assert.equal(connection.isFaulted, false);
  assert.equal(f.lock.faulted, false);
  assert.equal(executor.faulted, false);
  assert.equal(drained, true);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
  await assert.rejects(access(scriptDirectory), { code: 'ENOENT' });
});

test('swallowed unknown in version handler faults outer call and cannot be cleared by finally or stop', async (t) => {
  const f = await fixture(t);
  const connection = new PhotoshopConnection();
  connection.detector = { detect: async () => ({ version: 'mock', path: '', isRunning: true }) };
  let dispatches = 0;
  connection.executor = {
    isPhotoshopRunning: async () => true,
    execute: async () => { dispatches++; throw new ScriptExecutionError('DISCONNECTED', 'unknown'); },
  };
  f.registry.register('photoshop_get_version', definition('photoshop_get_version', async () => {
    try { return text(JSON.stringify(await connection.getVersionInfo())); }
    finally { await f.lock.completeDispatch('finished'); }
  }));
  await assert.rejects(f.registry.execute('photoshop_get_version', {}), /SESSION_FAULTED/);
  assert.equal(connection.isFaulted, true);
  assert.throws(() => { connection.isFaulted = false; }, TypeError);
  await assert.rejects(f.registry.execute('photoshop_get_version', {}), /SESSION_FAULTED/);
  await f.registry.stop();
  assert.equal(dispatches, 1);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'state'), 'utf8')).state, 'pending');
  await access(f.directory);
});

test('server stop shares its Promise and closes SDK only after registry drains', async () => {
  const server = new PhotoshopMCPServer();
  const drained = deferred();
  const events = [];
  server.toolRegistry = { stop: () => { events.push('seal'); return drained.promise; } };
  server.server = { close: async () => { events.push('close'); } };
  const first = server.stop();
  assert.equal(server.stop(), first);
  assert.deepEqual(events, ['seal']);
  await Promise.resolve();
  assert.deepEqual(events, ['seal']);
  drained.resolve();
  await first;
  assert.deepEqual(events, ['seal', 'close']);
});
