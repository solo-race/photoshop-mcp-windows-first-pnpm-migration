import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsProcessQueryError } from '../dist/platform/windows-process-query.js';

// Capture a registry stub at module import; no reg command or external shell runs.
let registryRead = async () => assert.fail('unexpected registry query');
const originalExec = childProcess.exec;
childProcess.exec = Object.assign(() => assert.fail('unexpected raw exec'), {
  [promisify.custom]: command => registryRead(command),
});
let WindowsDetector;
try {
  syncBuiltinESMExports();
  ({ WindowsDetector } = await import('../dist/platform/windows-detector.js'));
} finally {
  childProcess.exec = originalExec;
  syncBuiltinESMExports();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ps-detector-query-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'Photoshop.exe');
  await writeFile(path, 'offline path fixture');
  const oldPath = process.env.PHOTOSHOP_PATH;
  delete process.env.PHOTOSHOP_PATH;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PHOTOSHOP_PATH;
    else process.env.PHOTOSHOP_PATH = oldPath;
    registryRead = async () => assert.fail('unexpected registry query');
  });
  const detector = new WindowsDetector();
  const error = new WindowsProcessQueryError('PHOTOSHOP_RUNNING_QUERY_FAILED',
    new AggregateError([new Error('first'), new Error('second')]));
  let queries = 0, commonPaths = 0;
  detector.processQuery = { isPhotoshopRunning: async () => { queries++; throw error; } };
  detector.getCommonPaths = () => { commonPaths++; return []; };
  return { detector, path, error, queries: () => queries, commonPaths: () => commonPaths };
}

test('configured-path running query error escapes checkPath and detect unchanged', async (t) => {
  const f = await fixture(t);
  process.env.PHOTOSHOP_PATH = f.path;
  await assert.rejects(f.detector.detect(), error => error === f.error);
  assert.equal(f.queries(), 1);
  assert.equal(f.commonPaths(), 0);
});

test('Adobe and CLSID registry catch layers do not swallow running query errors or retry discovery', async (t) => {
  for (const source of ['Adobe', 'CLSID']) {
    const f = await fixture(t);
    const commands = [];
    registryRead = async command => {
      commands.push(command);
      if (source === 'Adobe') return {
        stdout: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\Photoshop\\25.0\n    ApplicationPath REG_SZ ${f.path}\n`,
      };
      return { stdout: command.includes('/ve') ? `    REG_SZ ${f.path}\n` : '' };
    };
    await assert.rejects(f.detector.detect(), error => error === f.error);
    assert.equal(f.queries(), 1);
    assert.equal(f.commonPaths(), 0);
    assert.equal(commands.length, source === 'Adobe' ? 1 : 3);
  }
});

test('ordinary registry failure still falls back to installation paths; successful zero remains false', async (t) => {
  for (const running of [false, true]) {
    const f = await fixture(t);
    registryRead = async () => { throw new Error('registry unavailable'); };
    f.detector.getCommonPaths = () => [f.path];
    f.detector.processQuery = { isPhotoshopRunning: async () => running };
    assert.equal((await f.detector.detect()).isRunning, running);
  }
});
