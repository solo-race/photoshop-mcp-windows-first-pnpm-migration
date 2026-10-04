import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { WindowsProcessQuery, WindowsProcessQueryError } from '../dist/platform/windows-process-query.js';
import { WindowsExecutor } from '../dist/platform/windows-executor.js';

function fixture(outcomes) {
  const query = new WindowsProcessQuery();
  const calls = [];
  query.run = async (executable, args, options) => {
    calls.push({ executable, args, options });
    assert.ok(calls.length <= outcomes.length, 'unexpected query retry');
    const outcome = outcomes[calls.length - 1];
    if (outcome instanceof Error) throw outcome;
    return { stdout: outcome, stderr: '' };
  };
  return { query, calls };
}

test('strict successful 0/1 uses one bounded powershell query, including no-match 0', async () => {
  for (const [output, expected] of [['0\r\n', false], ['1\r\n', true]]) {
    const f = fixture([output]);
    assert.equal(await f.query.isPhotoshopRunning(), expected);
    assert.equal(f.calls.length, 1);
    const { executable, args, options } = f.calls[0];
    assert.equal(executable, 'powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.match(args[4], /Get-Process -ErrorAction Stop/);
    assert.match(args[4], /\$_\.ProcessName -eq 'Photoshop'/);
    assert.doesNotMatch(args[4], /SilentlyContinue|tasklist|Stop-Process|taskkill/);
    assert.deepEqual(options, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384 });
    assert.equal(options.shell, undefined);
  }
});

test('unavailable, timed-out, nonzero and output-limited powershell fall back to pwsh once', async () => {
  const failures = [
    Object.assign(new Error('unavailable'), { code: 'ENOENT' }),
    Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('nonzero'), { code: 1 }),
    Object.assign(new Error('output limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
  ];
  for (const error of failures) {
    for (const [output, expected] of [['0', false], ['1', true]]) {
      const f = fixture([error, output]);
      assert.equal(await f.query.isPhotoshopRunning(), expected);
      assert.deepEqual(f.calls.map(call => call.executable), ['powershell.exe', 'pwsh']);
      assert.deepEqual(f.calls[1].args, f.calls[0].args);
      assert.deepEqual(f.calls[1].options, f.calls[0].options);
    }
  }
});

test('both failed queries preserve original causes and definite not-started without leaking them', async () => {
  const first = Object.assign(new Error('private installation path'), { code: 'ENOENT' });
  const second = Object.assign(new Error('private query stderr'), { code: 1 });
  const f = fixture([first, second]);
  await assert.rejects(f.query.isPhotoshopRunning(), error => {
    assert.ok(error instanceof WindowsProcessQueryError);
    assert.equal(error.message, 'PHOTOSHOP_RUNNING_QUERY_FAILED');
    assert.equal(error.completion, 'not-started');
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [first, second]);
    assert.doesNotMatch(String(error), /private/);
    return true;
  });
  assert.deepEqual(f.calls.map(call => call.executable), ['powershell.exe', 'pwsh']);
});

test('invalid successful output is an error, never false or a reason for fallback', async () => {
  for (const output of ['', 'True', '2', '0\n1', 'prefix 0']) {
    const f = fixture([output]);
    await assert.rejects(f.query.isPhotoshopRunning(), error => {
      assert.ok(error instanceof WindowsProcessQueryError);
      assert.equal(error.message, 'PHOTOSHOP_RUNNING_QUERY_INVALID_OUTPUT');
      assert.equal(error.completion, 'not-started');
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, 'RUNNING_QUERY_OUTPUT_NOT_BOOLEAN');
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const first = new Error('original failure');
  const f = fixture([first, 'invalid']);
  await assert.rejects(f.query.isPhotoshopRunning(), error => {
    assert.ok(error instanceof WindowsProcessQueryError);
    assert.equal(error.message, 'PHOTOSHOP_RUNNING_QUERY_INVALID_OUTPUT');
    assert.equal(error.completion, 'not-started');
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0], first);
    assert.equal(error.cause.errors[1].message, 'RUNNING_QUERY_OUTPUT_NOT_BOOLEAN');
    return true;
  });
});

test('finite execFile timeout terminates only a test-owned query child, then falls back', async () => {
  const query = new WindowsProcessQuery();
  let child, timedOut;
  const calls = [];
  query.run = async (executable, args, options) => {
    calls.push(executable);
    if (executable === 'pwsh') return { stdout: '0', stderr: '' };
    assert.equal(options.timeout, 5000);
    assert.equal(options.shell, undefined);
    // Substitute only this test's Node process; never launch PowerShell or Photoshop.
    return await new Promise((resolve, reject) => {
      child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options,
        (error, stdout, stderr) => {
          timedOut = error;
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
    });
  };
  assert.equal(await query.isPhotoshopRunning(), false);
  assert.equal(timedOut.killed, true);
  assert.equal(child.killed, true);
  assert.deepEqual(calls, ['powershell.exe', 'pwsh']);
});

test('Windows executor running query preserves true/false and propagates query failure', async () => {
  const executor = new WindowsExecutor();
  const f = fixture(['0', '1']);
  executor.processQuery = f.query;
  assert.equal(await executor.isPhotoshopRunning(), false);
  assert.equal(await executor.isPhotoshopRunning(), true);
  const first = new Error('first'), second = new Error('second');
  executor.processQuery = fixture([first, second]).query;
  await assert.rejects(executor.isPhotoshopRunning(), { completion: 'not-started' });
});
