import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/index.js', import.meta.url).href;
const cwd = fileURLToPath(new URL('..', import.meta.url));
const sensitive = 'PRIVATE_DOCUMENT_SCRIPT_MARKER';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ps-lock-test-'));
  const lock = join(root, 'photoshop-mcp-single-writer');
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill();
      await child.closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, lock,
    async existing(pid) {
      await mkdir(lock, { mode: 0o700 });
      if (pid !== undefined) await writeFile(join(lock, 'pid'), pid, { mode: 0o600 });
      await writeFile(join(lock, 'sentinel'), sensitive);
    },
    launch(prefix = '', script = `await import(${JSON.stringify(entry)});`) {
      const env = { ...process.env, TMP: root, TEMP: root, TMPDIR: root, LOG_LEVEL: '1' };
      delete env.PHOTOSHOP_PROJECTS_FILE;
      const child = spawn(process.execPath, ['--input-type=module', '-e', prefix + script], {
        cwd, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
      });
      let stdout = '', stderr = '', pending = '';
      const messages = [];
      let waiter;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try { messages.push(JSON.parse(line)); }
          catch (error) { waiter?.reject(error); }
        }
        waiter?.check();
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdin.on('error', () => {}); // An expected startup refusal closes the pipe.
      const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          waiter?.reject(new Error(`Child closed before response: ${code}/${signal}`));
          resolve({ code, signal, stdout, stderr });
        });
      });
      const handle = {
        process: child, closed,
        send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
        response(id) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(reject, new Error('MCP response timeout')), 10000);
            const finish = (callback, value) => { clearTimeout(timer); waiter = undefined; callback(value); };
            waiter = {
              reject: (error) => finish(reject, error),
              check() {
                const message = messages.find((item) => item.id === id);
                if (message) finish(resolve, message);
              },
            };
            waiter.check();
          });
        },
      };
      children.push(handle);
      return handle;
    },
  };
}

async function handshake(child) {
  child.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lock-regression', version: '1' },
  } });
  const initialized = await child.response(1);
  assert.ok(initialized.result?.serverInfo);
  child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  child.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(Array.isArray((await child.response(2)).result?.tools));
}

function refused(result, code, root) {
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`Failed to start server: ${code}(?:\\s|$)`));
  assert.ok(!result.stderr.includes(root));
  assert.ok(!result.stderr.includes(sensitive));
  assert.doesNotMatch(result.stderr, /Error:|\bat file:/);
}


function noPhotoshopPrefix(lock, counters = false) {
  const connection = new URL('../dist/platform/connection.js', import.meta.url).href;
  return `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const lock = ${JSON.stringify(lock)};
    let reads = [], mkdirs = 0, probes = 0;
    const originalRead = fs.readFile, originalMkdir = fs.mkdir;
    fs.readFile = async (path, ...args) => {
      if (path === lock + '/pid' || path === lock + '/state' ||
          path === lock + '\\\\pid' || path === lock + '\\\\state') reads.push(String(path));
      return originalRead(path, ...args);
    };
    fs.mkdir = async (path, ...args) => {
      if (path === lock) mkdirs++;
      return originalMkdir(path, ...args);
    };
    const originalKill = process.kill.bind(process);
    process.kill = (pid, signal) => { probes++; return originalKill(pid, signal); };
    syncBuiltinESMExports();
    const { PhotoshopConnection } = await import(${JSON.stringify(connection)});
    for (const key of ['detect', 'inspectDocuments', 'executeScript', 'getVersionInfo'])
      PhotoshopConnection.prototype[key] = async () => { throw new Error('UNEXPECTED_PHOTOSHOP_ACCESS'); };
    ${counters ? "process.once('exit', () => process.stderr.write('LOCK_COUNTS=' + JSON.stringify({reads,mkdirs,probes}) + '\\n'));" : ''}
  `;
}

test('multiple MCP processes handshake without accessing Photoshop or creating a writer lock', async (t) => {
  const f = await fixture(t);
  const first = f.launch(noPhotoshopPrefix(f.lock, true));
  const second = f.launch(noPhotoshopPrefix(f.lock, true));
  await Promise.all([handshake(first), handshake(second)]);
  await assert.rejects(stat(f.lock), { code: 'ENOENT' });
  for (const child of [first, second]) {
    child.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'photoshop_get_capabilities', arguments: {} } });
    assert.equal((await child.response(3)).result.isError, undefined);
    child.process.stdin.end();
    const result = await child.closed;
    assert.equal(result.code, 0);
    assert.match(result.stderr, /LOCK_COUNTS=\{"reads":\[\],"mkdirs":0,"probes":0\}/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_PHOTOSHOP_ACCESS/);
  }
  await assert.rejects(stat(f.lock), { code: 'ENOENT' });
});

test('existing writer does not block handshake; ping/version busy only read lock metadata once', async (t) => {
  const f = await fixture(t);
  await f.existing(String(process.pid));
  await writeFile(join(f.lock, 'state'), JSON.stringify({ state: 'idle', owner: 'test-owner' }));
  const before = await readFile(join(f.lock, 'state'), 'utf8');
  const child = f.launch(noPhotoshopPrefix(f.lock, true));
  await handshake(child);
  for (const [id, name] of [[3, 'photoshop_ping'], [4, 'photoshop_get_version']]) {
    child.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
    const response = (await child.response(id)).result;
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, 'WRITER_LOCK_ACTIVE');
  }
  child.send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'photoshop_get_capabilities', arguments: {} } });
  assert.equal((await child.response(5)).result.isError, undefined);
  child.process.stdin.end();
  const result = await child.closed;
  assert.equal(result.code, 0);
  const counters = JSON.parse(result.stderr.match(/LOCK_COUNTS=(\{[^\n]+\})/)[1]);
  assert.equal(counters.mkdirs, 2);
  assert.equal(counters.probes, 2);
  assert.equal(counters.reads.length, 4);
  assert.ok(counters.reads.every((path) => path === join(f.lock, 'pid') || path === join(f.lock, 'state')));
  assert.doesNotMatch(result.stderr, /UNEXPECTED_PHOTOSHOP_ACCESS/);
  assert.equal(await readFile(join(f.lock, 'state'), 'utf8'), before);
  assert.equal(await readFile(join(f.lock, 'sentinel'), 'utf8'), sensitive);
});

test('uncertain and pending writer metadata survive handshake and denied operations', async (t) => {
  for (const scenario of ['missing-pid', 'invalid-pid', 'missing-state', 'pending']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      await f.existing(scenario === 'missing-pid' ? undefined : scenario === 'invalid-pid' ? 'abc' : String(process.pid));
      if (scenario !== 'missing-state')
        await writeFile(join(f.lock, 'state'), JSON.stringify({ state: scenario === 'pending' ? 'pending' : 'idle', owner: 'test-owner' }));
      const child = f.launch(noPhotoshopPrefix(f.lock));
      await handshake(child);
      child.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'photoshop_ping', arguments: {} } });
      const response = (await child.response(3)).result;
      assert.equal(response.isError, true);
      assert.equal(response.content[0].text, scenario === 'pending' ? 'WRITER_LOCK_PENDING' : 'WRITER_LOCK_UNCERTAIN');
      child.process.stdin.end();
      assert.equal((await child.closed).code, 0);
      assert.equal(await readFile(join(f.lock, 'sentinel'), 'utf8'), sensitive);
    });
  }
});

test('unrecognized startup Error is generic even with code-like sensitive content', async (t) => {
  const f = await fixture(t);
  const server = new URL('../dist/core/server.js', import.meta.url).href;
  const prefix = `
    const { PhotoshopMCPServer } = await import(${JSON.stringify(server)});
    PhotoshopMCPServer.prototype.start = async () => {
      throw new Error(${JSON.stringify(`WRITER_LOCK_ACTIVE ${f.root} ${sensitive}`)});
    };
  `;
  refused(await f.launch(prefix).closed, 'STARTUP_FAILED', f.root);
});
