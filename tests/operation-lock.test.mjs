import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationLock } from '../dist/core/operation-lock.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ps-operation-lock-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'lock');
}
async function stale(directory, state = 'idle') {
  await mkdir(directory);
  await writeFile(join(directory, 'pid'), '777');
  await writeFile(join(directory, 'state'), JSON.stringify({ state, owner: 'old-owner' }));
}
const stateOf = async (directory) => JSON.parse(await readFile(join(directory, 'state'), 'utf8'));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('pending persists before dispatch; only definite completion makes idle and permits release', async (t) => {
  for (const completion of ['finished', 'not-started']) {
    const directory = await fixture(t);
    const lock = new OperationLock(directory);
    await lock.acquire();
    assert.equal((await stateOf(directory)).state, 'idle');
    await lock.beginDispatch();
    assert.equal((await stateOf(directory)).state, 'pending');
    await lock.completeDispatch(completion);
    assert.equal((await stateOf(directory)).state, 'idle');
    await lock.release();
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
});

test('unknown is sticky across later success, release and reacquisition', async (t) => {
  const directory = await fixture(t);
  const lock = new OperationLock(directory);
  await lock.acquire();
  await lock.beginDispatch();
  await lock.completeDispatch('unknown');
  await lock.completeDispatch('finished');
  await lock.release();
  assert.equal(lock.faulted, true);
  assert.equal((await stateOf(directory)).state, 'pending');
  await assert.rejects(lock.beginDispatch(), /SESSION_FAULTED/);
  await assert.rejects(lock.acquire(), /SESSION_FAULTED/);
  const other = new OperationLock(directory);
  other.isDead = () => true;
  await assert.rejects(other.acquire(), /WRITER_LOCK_PENDING/);
});

test('pending and idle write failures prevent dispatch or release', async (t) => {
  for (const phase of ['pending', 'idle']) {
    const directory = await fixture(t);
    const lock = new OperationLock(directory);
    await lock.acquire();
    if (phase === 'idle') await lock.beginDispatch();
    lock.writeState = async () => { throw new Error('disk failure'); };
    if (phase === 'pending') await assert.rejects(lock.beginDispatch(), /PENDING_WRITE_FAILED/);
    else await assert.rejects(lock.completeDispatch('finished'), /SETTLEMENT_FAILED/);
    await lock.release();
    assert.equal(lock.faulted, true);
    await access(directory);
    assert.equal((await stateOf(directory)).state, phase === 'idle' ? 'pending' : 'idle');
  }
});

test('busy reads metadata once, with no acquisition retry or directory deletion', async (t) => {
  const directory = await fixture(t);
  const first = new OperationLock(directory);
  await first.acquire();
  const other = new OperationLock(directory);
  let probes = 0;
  other.isDead = (pid) => { assert.equal(pid, process.pid); probes++; return false; };
  other.removeDirectory = async () => { assert.fail('busy must not remove'); };
  await assert.rejects(other.acquire(), /WRITER_LOCK_ACTIVE/);
  assert.equal(probes, 1);
  await first.release();
});

test('untrusted state, pending, unknown PID and existing recovery are never reclaimed', async (t) => {
  for (const scenario of ['missing-state', 'pending', 'unknown-pid', 'recovery']) {
    const directory = await fixture(t);
    await stale(directory, scenario === 'pending' ? 'pending' : 'idle');
    if (scenario === 'missing-state') await rm(join(directory, 'state'));
    if (scenario === 'recovery') {
      await mkdir(directory + '.recovery');
      await writeFile(join(directory + '.recovery', 'pid'), 'untrusted');
    }
    const lock = new OperationLock(directory);
    lock.isDead = () => {
      if (scenario === 'unknown-pid') throw new Error('WRITER_LOCK_UNCERTAIN');
      return true;
    };
    lock.removeDirectory = async () => { assert.fail('must not remove'); };
    await assert.rejects(lock.acquire(), /WRITER_LOCK_(UNCERTAIN|PENDING|RECOVERY_BUSY)/);
    assert.equal(await readFile(join(directory, 'pid'), 'utf8'), '777');
    if (scenario === 'recovery') assert.equal(await readFile(join(directory + '.recovery', 'pid'), 'utf8'), 'untrusted');
  }
});

test('two stale snapshots: second recovery owner rereads and preserves the new owner', async (t) => {
  const directory = await fixture(t);
  await stale(directory);
  const first = new OperationLock(directory);
  const second = new OperationLock(directory);
  first.isDead = second.isDead = (pid) => pid === 777;
  const staleRead = deferred();
  const newOwner = deferred();
  const read = second.requireDeadIdle.bind(second);
  let reads = 0;
  second.requireDeadIdle = async () => {
    await read();
    if (++reads === 1) { staleRead.resolve(); await newOwner.promise; }
  };
  const result = assert.rejects(second.acquire(), /WRITER_LOCK_ACTIVE/);
  await staleRead.promise;
  await first.acquire();
  const owned = await stateOf(directory);
  newOwner.resolve();
  await result;
  assert.deepEqual(await stateOf(directory), owned);
  await assert.rejects(access(directory + '.recovery'), { code: 'ENOENT' });
  await first.release();
});

test('gap winner is preserved when recovering owner loses its only mkdir retry', async (t) => {
  const directory = await fixture(t);
  await stale(directory);
  const recovering = new OperationLock(directory);
  const third = new OperationLock(directory);
  recovering.isDead = (pid) => pid === 777;
  const remove = recovering.removeDirectory.bind(recovering);
  let primaryRemovals = 0;
  recovering.removeDirectory = async (path) => {
    await remove(path);
    if (path === directory) { primaryRemovals++; await third.acquire(); }
  };
  await assert.rejects(recovering.acquire(), /WRITER_LOCK_RECOVERY_FAILED/);
  assert.equal(primaryRemovals, 1);
  assert.equal(await readFile(join(directory, 'pid'), 'utf8'), String(process.pid));
  await third.beginDispatch();
  await third.completeDispatch('finished');
  await third.release();
});

test('release verifies the exact owner and never deletes changed ownership', async (t) => {
  const directory = await fixture(t);
  const lock = new OperationLock(directory);
  await lock.acquire();
  await writeFile(join(directory, 'state'), JSON.stringify({ state: 'idle', owner: 'different-owner' }));
  await assert.rejects(lock.release(), /WRITER_LOCK_RELEASE_FAILED/);
  assert.equal((await stateOf(directory)).owner, 'different-owner');
});
