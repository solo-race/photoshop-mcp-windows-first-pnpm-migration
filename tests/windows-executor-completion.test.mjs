import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { rm } from 'node:fs/promises';
import { WindowsExecutor, ScriptExecutionError } from '../dist/platform/windows-executor.js';

function executorWithChild(events, { pid = 123, timeout = 1000 } = {}) {
  const executor = new WindowsExecutor();
  let launches = 0;
  let terminations = 0;
  executor.spawnScriptProcess = () => {
    launches++;
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => events(child));
    return child;
  };
  executor.terminateProcessTree = async () => { terminations++; };
  return { executor, run: () => executor.execute('fixture', timeout),
    launches: () => launches, terminations: () => terminations };
}

const classified = (completion) => (error) => {
  assert.ok(error instanceof ScriptExecutionError);
  assert.equal(error.completion, completion);
  return true;
};

test('successful response and script-error JSON both finish dispatch', async () => {
  for (const result of [{ value: 1 }, { error: 'script refused' }]) {
    const fixture = executorWithChild((child) => {
      child.emit('spawn');
      child.stdout.write(JSON.stringify(result));
      child.emit('close', 0);
    });
    assert.deepEqual(await fixture.run(), result);
  }
});

test('setup, synchronous spawn failure and proven failed spawn are not-started', async () => {
  const setup = new WindowsExecutor();
  setup.createVBSWrapper = () => { throw new Error('setup'); };
  await assert.rejects(setup.execute('fixture'), classified('not-started'));
  const sync = new WindowsExecutor();
  sync.spawnScriptProcess = () => { throw new Error('spawn'); };
  await assert.rejects(sync.execute('fixture'), classified('not-started'));
  const failed = executorWithChild((child) => child.emit('error', new Error('ENOENT')),
    { pid: undefined });
  // Explicitly omit PID; the helper default applies to an undefined argument.
  failed.executor.spawnScriptProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  await assert.rejects(failed.run(), classified('not-started'));
});

test('ERROR prefix, nonzero, killed and disconnected processes remain unknown', async () => {
  const outcomes = [
    (child) => { child.stdout.write('ERROR: DoJavaScriptFile ERROR: disconnected'); child.emit('close', 1); },
    (child) => { child.stdout.write('ERROR: ambiguous'); child.emit('close', 0); },
    (child) => child.emit('close', 2),
    (child) => child.emit('close', null, 'SIGTERM'),
    (child) => child.emit('error', new Error('disconnected')),
  ];
  for (const outcome of outcomes) {
    const fixture = executorWithChild((child) => { child.emit('spawn'); outcome(child); });
    await assert.rejects(fixture.run(), classified('unknown'));
  }
});

test('timeout and both output limits are unknown and terminate only fake child', async () => {
  const timeout = executorWithChild((child) => child.emit('spawn'), { timeout: 1 });
  await assert.rejects(timeout.run(), classified('unknown'));
  assert.equal(timeout.terminations(), 1);
  for (const [stream, size] of [['stdout', 4 * 1024 * 1024], ['stderr', 1024 * 1024]]) {
    const fixture = executorWithChild((child) => {
      child.emit('spawn'); child[stream].write('x'.repeat(size + 1));
    });
    await assert.rejects(fixture.run(), classified('unknown'));
    assert.equal(fixture.terminations(), 1);
  }
});

test('unknown stops queued executor work and remains sticky', async () => {
  const fixture = executorWithChild((child) => { child.emit('spawn'); child.emit('close', 1); });
  const first = fixture.run();
  const second = fixture.run();
  await Promise.all([
    assert.rejects(first, classified('unknown')),
    assert.rejects(second, classified('unknown')),
  ]);
  await assert.rejects(fixture.run(), classified('unknown'));
  assert.equal(fixture.launches(), 1);
});

test('cleanup cannot overwrite unknown; cleanup after a response is finished', async (t) => {
  const directories = [];
  t.after(async () => { for (const dir of directories) await rm(dir, { recursive: true, force: true }); });
  for (const [code, expected] of [[1, 'unknown'], [0, 'finished']]) {
    const fixture = executorWithChild((child) => {
      child.emit('spawn'); child.stdout.write('{}'); child.emit('close', code);
    });
    fixture.executor.removeTempDirectory = async (directory) => {
      directories.push(directory); throw new Error('cleanup');
    };
    await assert.rejects(fixture.run(), classified(expected));
  }
});
