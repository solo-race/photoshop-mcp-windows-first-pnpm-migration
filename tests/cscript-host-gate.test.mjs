import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, runHostGate } from './helpers/cscript-host-gate.mjs';

const tmpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.tmp');
const outDir = path.join(tmpRoot, 'cscript-host-gate-evidence');
const marker = Buffer.from('CSCRIPT_HOST_GATE\r\n', 'ascii');

// Pure memory fixtures: these tests never spawn a process or write evidence.
function fixture({ error = null, stdout = marker, stderr = Buffer.alloc(0), exists = false,
  failWrite, evidenceDirectory = 'cscript-host-gate-evidence' } = {}) {
  const outDir = path.join(tmpRoot, evidenceDirectory);
  const files = new Map();
  const calls = [];
  let directoryExists = exists;
  let mkdirCalls = 0;
  const dependencies = {
    async mkdir(target, options) {
      mkdirCalls++;
      assert.equal(target, outDir);
      assert.deepEqual(options, { recursive: false });
      if (directoryExists) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
      directoryExists = true;
    },
    async writeFile(target, data, options) {
      assert.equal(path.dirname(target), outDir);
      assert.equal(options.flag, 'wx');
      assert.equal(files.has(target), false);
      if (path.basename(target) === failWrite) {
        throw Object.assign(new Error('fixture persistence failure'), { code: 'EIO' });
      }
      files.set(target, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, options.encoding));
    },
    execFile(executable, args, options, callback) {
      calls.push({ executable, args, options });
      callback(error, stdout, stderr);
    },
  };
  return { dependencies, files, calls, read: name => files.get(path.join(outDir, name)),
    get mkdirCalls() { return mkdirCalls; }, get directoryExists() { return directoryExists; } };
}

test('default/help and unsupported inputs perform no preparation or execution', async () => {
  const f = fixture();
  for (const [args, code] of [[[], 0], [['--help'], 0], [['--run', '--run'], 2],
    [['--script', 'input.vbs'], 2], [['--cleanup'], 2],
    [['--evidence-dir', 'cscript-host-gate-unsandboxed-evidence'], 2],
    [['--run', '--evidence-dir', '../outside'], 2],
    [['--run', '--evidence-dir', 'unknown-evidence'], 2]]) {
    assert.equal(await main(args, f.dependencies), code);
  }
  assert.equal(f.mkdirCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.files.size, 0);
});

test('only the fixed Echo script runs once with bounded binary execFile options', async () => {
  const f = fixture();
  const result = await runHostGate(f.dependencies);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], {
    executable: 'cscript.exe', args: ['//nologo', path.join(outDir, 'host-gate.vbs')],
    options: { encoding: 'buffer', windowsHide: true, timeout: 5000, maxBuffer: 16384, shell: false },
  });
  assert.equal(f.read('host-gate.vbs').toString('ascii'), 'WScript.Echo "CSCRIPT_HOST_GATE"\r\n');
  assert.deepEqual([...f.files.keys()].map(p => path.basename(p)), [
    'run-started.json', 'host-gate.vbs', 'stdout.bin', 'stderr.bin', 'run-result.json',
  ]);
  assert.deepEqual(f.read('stdout.bin'), marker);
  assert.deepEqual(f.read('stderr.bin'), Buffer.alloc(0));
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.equal(result.errorCode, null);
  assert.equal(result.killed, false);
  assert.deepEqual(JSON.parse(f.read('run-result.json')), result);
  await assert.rejects(runHostGate(f.dependencies), { code: 'EEXIST' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.directoryExists, true);
});

for (const [name, response] of [
  ['nonzero with undecoded bytes', { error: Object.assign(new Error('exit'), { code: 1 }),
    stdout: Buffer.from([0xff, 0x00, 0x81]), stderr: Buffer.from([0xb4, 0xed, 0xce, 0xf3]) }],
  ['missing executable', { error: Object.assign(new Error('spawn'), { code: 'ENOENT' }),
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }],
  ['timeout despite marker', { error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }) }],
  ['buffer limit', { error: Object.assign(new Error('limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }],
  ['stderr despite zero exit', { stderr: Buffer.from([0x81, 0x40]) }],
  ['decoded-looking marker is not raw ASCII', { stdout: Buffer.from('CSCRIPT_HOST_GATE\r\n', 'utf16le') }],
]) {
  test(`hostdiag STOP preserves raw evidence and never retries: ${name}`, async () => {
    const f = fixture(response);
    assert.equal(await main(['--run'], f.dependencies), 1);
    assert.equal(f.calls.length, 1);
    const result = JSON.parse(f.read('run-result.json'));
    assert.equal(result.phase, 'hostdiag');
    assert.equal(result.status, 'STOP');
    assert.equal(result.exitCode, response.error ?
      (typeof response.error.code === 'number' ? response.error.code : null) : 0);
    assert.equal(result.errorCode, response.error?.code ?? null);
    assert.equal(result.killed, response.error?.killed === true);
    assert.equal(result.signal, response.error?.signal ?? null);
    for (const stream of ['stdout', 'stderr']) {
      const bytes = response[stream] ?? (stream === 'stdout' ? marker : Buffer.alloc(0));
      assert.deepEqual(f.read(`${stream}.bin`), bytes);
      assert.deepEqual(result[stream], { file: `${stream}.bin`, bytes: bytes.length, decoder: 'none' });
    }
    assert.match(result.offlineDecodePolicy, /GBK.*cannot change/);
    assert.equal(result.originalPhotoshopDispatchInference, 'none');
    assert.equal(result.pendingStateAction, 'none');
    assert.equal(f.directoryExists, true);
  });
}

test('preexisting evidence blocks execution without touching its contents', async () => {
  const f = fixture({ exists: true });
  assert.equal(await main(['--run'], f.dependencies), 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.files.size, 0);
  assert.equal(f.directoryExists, true);
});

for (const failWrite of ['host-gate.vbs', 'run-result.json']) {
  test(`persistence failure retains prior evidence without cleanup/retry: ${failWrite}`, async () => {
    const f = fixture({ failWrite });
    assert.equal(await main(['--run'], f.dependencies), 1);
    assert.equal(f.calls.length, failWrite === 'host-gate.vbs' ? 0 : 1);
    assert.ok(f.read('run-started.json'));
    if (failWrite === 'run-result.json') assert.deepEqual(f.read('stdout.bin'), marker);
    assert.equal(f.directoryExists, true);
    assert.equal(await main(['--run'], f.dependencies), 1);
    assert.equal(f.calls.length, failWrite === 'host-gate.vbs' ? 0 : 1);
  });
}

test('explicit alternate evidence directory uses the same fixed host gate and refuses reuse', async () => {
  const evidenceDirectory = 'cscript-host-gate-unsandboxed-evidence';
  const f = fixture({ evidenceDirectory });
  const args = ['--run', '--evidence-dir', evidenceDirectory];
  assert.equal(await main(args, f.dependencies), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[1], path.join(tmpRoot, evidenceDirectory, 'host-gate.vbs'));
  const result = JSON.parse(f.read('run-result.json'));
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.args, ['//nologo', path.join('.tmp', evidenceDirectory, 'host-gate.vbs')]);
  assert.deepEqual(f.read('stdout.bin'), marker);
  assert.equal(await main(args, f.dependencies), 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.directoryExists, true);
});
