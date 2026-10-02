import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
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

async function deadPid(f) {
  const child = f.launch('', 'process.exit(0);');
  const pid = child.process.pid;
  assert.equal((await child.closed).code, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return String(pid);
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

test('fresh and confirmed-dead locks handshake and release ownership on stdin EOF', async (t) => {
  for (const stale of [false, true]) {
    await t.test(stale ? 'real exited writer' : 'fresh writer', async (t) => {
      const f = await fixture(t);
      const neighbor = join(f.root, 'unrelated');
      await writeFile(neighbor, sensitive);
      if (stale) await f.existing(await deadPid(f));
      const child = f.launch();
      await handshake(child);
      assert.equal(await readFile(join(f.lock, 'pid'), 'utf8'), String(child.process.pid));
      assert.deepEqual(await readdir(f.lock), ['pid']);
      if (process.platform !== 'win32') {
        assert.equal((await stat(f.lock)).mode & 0o777, 0o700);
        assert.equal((await stat(join(f.lock, 'pid'))).mode & 0o777, 0o600);
      }
      child.process.stdin.end();
      const result = await child.closed;
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      for (const line of result.stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
      await assert.rejects(stat(f.lock), { code: 'ENOENT' });
      assert.equal(await readFile(neighbor, 'utf8'), sensitive);
    });
  }
});

test('active, missing and invalid PID locks refuse and remain untouched', async (t) => {
  for (const pid of [String(process.pid), undefined, '', '0', '-1', '1.5', 'abc', '9007199254740992']) {
    await t.test(`PID ${pid ?? 'missing'}`, async (t) => {
      const f = await fixture(t);
      await f.existing(pid);
      refused(await f.launch().closed, pid === String(process.pid) ? 'WRITER_LOCK_ACTIVE' : 'WRITER_LOCK_UNCERTAIN', f.root);
      assert.equal(await readFile(join(f.lock, 'sentinel'), 'utf8'), sensitive);
      if (pid === undefined) await assert.rejects(readFile(join(f.lock, 'pid')), { code: 'ENOENT' });
      else assert.equal(await readFile(join(f.lock, 'pid'), 'utf8'), pid);
    });
  }
});

test('permission and unknown PID probe failures preserve the existing lock', async (t) => {
  for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
    await t.test(code, async (t) => {
      const f = await fixture(t);
      await f.existing(String(process.pid));
      const prefix = `process.kill = () => { throw Object.assign(new Error(${JSON.stringify(sensitive)}), { code: ${JSON.stringify(code)} }); };`;
      refused(await f.launch(prefix).closed, 'WRITER_LOCK_UNCERTAIN', f.root);
      assert.equal(await readFile(join(f.lock, 'pid'), 'utf8'), String(process.pid));
      assert.equal(await readFile(join(f.lock, 'sentinel'), 'utf8'), sensitive);
    });
  }
});

test('failed stale removal or single reacquisition never starts a writer', async (t) => {
  for (const operation of ['rm', 'mkdir']) {
    await t.test(operation, async (t) => {
      const f = await fixture(t);
      const pid = await deadPid(f);
      await f.existing(pid);
      const prefix = `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const lock = ${JSON.stringify(f.lock)};
        const original = fs.${operation};
        let attempts = 0;
        fs.${operation} = async (target, options) => {
          if (target === lock) {
            attempts++;
            ${operation === 'mkdir' ? 'if (attempts === 1) return original(target, options);' : ''}
            throw Object.assign(new Error(${JSON.stringify(sensitive)}), { code: 'EACCES' });
          }
          return original(target, options);
        };
        syncBuiltinESMExports();
        process.once('exit', () => process.stderr.write('LOCK_ATTEMPTS=' + attempts + '\\n'));
      `;
      const result = await f.launch(prefix).closed;
      refused(result, 'WRITER_LOCK_RECOVERY_FAILED', f.root);
      assert.match(result.stderr, new RegExp(`LOCK_ATTEMPTS=${operation === 'rm' ? 1 : 2}\\n`));
      if (operation === 'rm') {
        assert.equal(await readFile(join(f.lock, 'pid'), 'utf8'), pid);
        assert.equal(await readFile(join(f.lock, 'sentinel'), 'utf8'), sensitive);
      } else await assert.rejects(stat(f.lock), { code: 'ENOENT' });
    });
  }
});

test('PID write failure cleans owned lock and reports only its safe code', async (t) => {
  const f = await fixture(t);
  const prefix = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    fs.writeFile = async () => { throw new Error(${JSON.stringify(sensitive)}); };
    syncBuiltinESMExports();
  `;
  refused(await f.launch(prefix).closed, 'WRITER_LOCK_PID_WRITE_FAILED', f.root);
  await assert.rejects(stat(f.lock), { code: 'ENOENT' });
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
