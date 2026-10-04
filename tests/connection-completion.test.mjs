import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhotoshopConnection } from '../dist/platform/connection.js';
import { ScriptExecutionError } from '../dist/platform/windows-executor.js';
import { WindowsProcessQuery, WindowsProcessQueryError } from '../dist/platform/windows-process-query.js';
import { OperationLock, operationContext } from '../dist/core/operation-lock.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ps-completion-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = new OperationLock(join(root, 'lock'));
  const connection = new PhotoshopConnection();
  const state = async () => JSON.parse(await readFile(join(lock.directory, 'state'), 'utf8')).state;
  const control = { stopped: false, calls: 0, error: null, result: { error: 'script-level error' } };
  connection.detector = { detect: async () => ({ version: 'mock', path: '', isRunning: true }) };
  connection.executor = {
    isPhotoshopRunning: async () => true,
    execute: async () => {
      control.calls++;
      assert.equal(await state(), 'pending');
      if (control.error) throw control.error;
      return control.result;
    },
  };
  await lock.acquire();
  const run = (callback = () => connection.executeScript('mock script')) =>
    operationContext.run({ lock, isStopping: () => control.stopped }, callback);
  return { lock, connection, state, control, run };
}

test('successful response including script error JSON settles pending to idle', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), f.control.result);
  assert.equal(await f.state(), 'idle');
  assert.equal(f.connection.isFaulted, false);
  await f.lock.release();
  await assert.rejects(access(f.lock.directory), { code: 'ENOENT' });
});

test('not-started and finished executor errors preserve completion and allow definite settlement', async (t) => {
  for (const completion of ['not-started', 'finished']) {
    const f = await fixture(t);
    const error = new ScriptExecutionError('EXPLICIT_COMPLETION', completion);
    f.control.error = error;
    await assert.rejects(f.run(), (actual) => actual === error && actual.completion === completion);
    assert.equal(await f.state(), 'idle');
    assert.equal(f.connection.isFaulted, false);
    f.control.error = null;
    await f.run();
    await f.lock.release();
  }
});

test('typed or unclassified unknown is sticky and cannot dispatch again or release pending', async (t) => {
  for (const error of [new ScriptExecutionError('DISCONNECTED', 'unknown'), new Error('UNCLASSIFIED')]) {
    const f = await fixture(t);
    f.control.error = error;
    await assert.rejects(f.run(), (actual) => actual.completion === 'unknown');
    assert.equal(f.connection.isFaulted, true);
    assert.throws(() => { f.connection.isFaulted = false; }, TypeError);
    f.control.error = null;
    await assert.rejects(f.run(), /SESSION_FAULTED/);
    await f.lock.completeDispatch('finished');
    await f.lock.release();
    assert.equal(f.control.calls, 1);
    assert.equal(await f.state(), 'pending');
  }
});

test('pending persistence failure prevents executor dispatch; settlement failure retains fault and lock', async (t) => {
  for (const phase of ['pending', 'idle']) {
    const f = await fixture(t);
    const write = f.lock.writeState.bind(f.lock);
    f.lock.writeState = async (state) => {
      if (state === phase) throw new Error('DISK_WRITE_FAILED');
      await write(state);
    };
    await assert.rejects(f.run(), phase === 'pending' ? /PENDING_WRITE_FAILED/ : /SETTLEMENT_FAILED/);
    assert.equal(f.control.calls, phase === 'pending' ? 0 : 1);
    assert.equal(f.connection.isFaulted, true);
    await f.lock.release();
    await access(f.lock.directory);
    await assert.rejects(f.run(), /SESSION_FAULTED/);
  }
});

test('stop before dispatch, including during pending write, launches no executor and settles idle', async (t) => {
  for (const phase of ['before', 'during-pending']) {
    const f = await fixture(t);
    if (phase === 'before') f.control.stopped = true;
    else {
      const begin = f.lock.beginDispatch.bind(f.lock);
      f.lock.beginDispatch = async () => { await begin(); f.control.stopped = true; };
    }
    await assert.rejects(f.run(), /SERVER_STOPPING/);
    assert.equal(f.control.calls, 0);
    assert.equal(await f.state(), 'idle');
    await f.lock.release();
  }
});

test('both failed running queries before dispatch preserve causes, idle and no fault', async (t) => {
  for (const phase of ['detector', 'executor']) {
    const f = await fixture(t);
    const first = Object.assign(new Error('query unavailable'), { code: 'ENOENT' });
    const second = Object.assign(new Error('query timeout'), { killed: true });
    const query = new WindowsProcessQuery();
    const calls = [];
    query.run = async executable => {
      calls.push(executable);
      throw executable === 'powershell.exe' ? first : second;
    };
    let pendingWrites = 0;
    const begin = f.lock.beginDispatch.bind(f.lock);
    f.lock.beginDispatch = async () => { pendingWrites++; await begin(); };
    if (phase === 'detector') f.connection.detector.detect = async () => {
      await query.isPhotoshopRunning();
      assert.fail('failed running query cannot become installed/not-running');
    };
    else f.connection.executor.isPhotoshopRunning = () => query.isPhotoshopRunning();
    await assert.rejects(f.run(), error => {
      assert.ok(error instanceof WindowsProcessQueryError);
      assert.equal(error.message, 'PHOTOSHOP_RUNNING_QUERY_FAILED');
      assert.equal(error.completion, 'not-started');
      assert.deepEqual(error.cause.errors, [first, second]);
      return true;
    });
    assert.deepEqual(calls, ['powershell.exe', 'pwsh']);
    assert.equal(f.control.calls, 0);
    assert.equal(pendingWrites, 0);
    assert.equal(await f.state(), 'idle');
    assert.equal(f.connection.isFaulted, false);
    assert.equal(f.lock.faulted, false);
    await f.lock.release();
    await assert.rejects(access(f.lock.directory), { code: 'ENOENT' });
  }
});

test('invalid running-query output before dispatch preserves causes, idle and no fault', async (t) => {
  for (const phase of ['detector', 'executor']) {
    for (const fallback of [false, true]) {
      const f = await fixture(t);
      const first = Object.assign(new Error('query unavailable'), { code: 'ENOENT' });
      const query = new WindowsProcessQuery();
      const calls = [];
      query.run = async executable => {
        calls.push(executable);
        if (fallback && executable === 'powershell.exe') throw first;
        return { stdout: 'invalid', stderr: '' };
      };
      let pendingWrites = 0;
      const begin = f.lock.beginDispatch.bind(f.lock);
      f.lock.beginDispatch = async () => { pendingWrites++; await begin(); };
      if (phase === 'detector') f.connection.detector.detect = async () => {
        await query.isPhotoshopRunning();
        assert.fail('invalid running query cannot become installed/not-running');
      };
      else f.connection.executor.isPhotoshopRunning = () => query.isPhotoshopRunning();
      await assert.rejects(f.run(), error => {
        assert.ok(error instanceof WindowsProcessQueryError);
        assert.equal(error.message, 'PHOTOSHOP_RUNNING_QUERY_INVALID_OUTPUT');
        assert.equal(error.completion, 'not-started');
        if (fallback) {
          assert.ok(error.cause instanceof AggregateError);
          assert.equal(error.cause.errors[0], first);
          assert.equal(error.cause.errors[1].message, 'RUNNING_QUERY_OUTPUT_NOT_BOOLEAN');
        } else assert.equal(error.cause.message, 'RUNNING_QUERY_OUTPUT_NOT_BOOLEAN');
        return true;
      });
      assert.deepEqual(calls, fallback ? ['powershell.exe', 'pwsh'] : ['powershell.exe']);
      assert.equal(f.control.calls, 0);
      assert.equal(pendingWrites, 0);
      assert.equal(await f.state(), 'idle');
      assert.equal(f.connection.isFaulted, false);
      assert.equal(f.lock.faulted, false);
      await f.lock.release();
      await assert.rejects(access(f.lock.directory), { code: 'ENOENT' });
    }
  }
});

test('policy recheck rejection creates no pending', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(() => f.connection.withScope({
    recheck: async () => { throw new Error('GRANT_RECHECK_DENIED'); },
  }, () => f.connection.executeScript('mock script'))), /GRANT_RECHECK_DENIED/);
  assert.equal(f.control.calls, 0);
  assert.equal(await f.state(), 'idle');
  await f.lock.release();
});

test('direct connection calls serialize under their own operation lock and retain unknown', async (t) => {
  const f = await fixture(t);
  await f.lock.release();
  f.connection.directLock = f.lock;
  const results = await Promise.all([
    f.connection.executeScript('first'), f.connection.executeScript('second'),
  ]);
  assert.deepEqual(results, [f.control.result, f.control.result]);
  assert.equal(f.control.calls, 2);
  await assert.rejects(access(f.lock.directory), { code: 'ENOENT' });
  f.control.error = new ScriptExecutionError('DIRECT_DISCONNECTED', 'unknown');
  await assert.rejects(f.connection.executeScript('third'), { completion: 'unknown' });
  await assert.rejects(f.connection.executeScript('fourth'), /SESSION_FAULTED/);
  assert.equal(f.control.calls, 3);
  assert.equal(await f.state(), 'pending');
});

test('scope guard error response is definite completion and preserves its original reason', async (t) => {
  const f = await fixture(t);
  f.control.result = { __mcp_scope_error: 'TARGET_LAYER_CHANGED' };
  await assert.rejects(f.run(() => f.connection.withScope({ recheck: async () => {} },
    () => f.connection.executeScript('mock script'))), {
    completion: 'finished', message: 'TARGET_LAYER_CHANGED',
  });
  assert.equal(await f.state(), 'idle');
  assert.equal(f.connection.isFaulted, false);
  await f.lock.release();
});
