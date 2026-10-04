import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PhotoshopConnection } from '../dist/platform/connection.js';
import { ScriptExecutionError } from '../dist/platform/windows-executor.js';
import { OperationLock, operationContext } from '../dist/core/operation-lock.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhotoshopAPIFactory } from '../dist/api/photoshop-api.js';

function operationTest(name, run) {
  test(name, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ps-session-test-'));
    const lock = new OperationLock(join(root, 'operation'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await lock.acquire();
    try {
      await operationContext.run({ lock, isStopping: () => false }, () => run(t));
    } finally {
      await lock.release();
    }
  });
}

class ActionDescriptor {
  constructor(values = new Map()) {
    this.values = new Map(values);
  }

  putString(key, value) {
    this.values.set(key, value);
  }

  getString(key) {
    const value = this.values.get(key);
    if (typeof value !== 'string') throw new Error('DESCRIPTOR_STRING_UNAVAILABLE');
    return value;
  }
}

function fixture() {
  const options = new Map();
  const puts = [];
  const globals = [];
  const nestedLayer = { id: 8, typename: 'ArtLayer' };
  const target = {
    id: 7,
    layers: [{ id: 9, typename: 'LayerSet', layers: [nestedLayer] }],
    get fullName() { throw new Error('UNSAVED_DOCUMENT'); },
  };
  const other = { id: 99, layers: [] };
  const control = {
    executionError: null, responseError: null, lookupError: null, putError: null,
    documentError: null, documentReads: 0, rechecks: 0,
  };
  const app = {
    name: 'Adobe Photoshop', version: '26.0', build: 'controlled',
    activeDocument: other, displayDialogs: 'ALL', operations: 0,
    get documents() {
      control.documentReads++;
      if (control.documentError) throw control.documentError;
      return [other, target];
    },
    putCustomOptions(key, descriptor, persistent) {
      if (control.putError) throw control.putError;
      puts.push({ key, persistent });
      options.set(key, new ActionDescriptor(descriptor.values));
    },
    getCustomOptions(key) {
      if (control.lookupError) throw control.lookupError;
      if (!options.has(key)) throw new Error('NO_SUCH_ELEMENT');
      return new ActionDescriptor(options.get(key).values);
    },
  };
  const connection = new PhotoshopConnection();
  connection.detector = {
    detect: async () => ({ version: app.version, path: '', isRunning: true }),
  };
  connection.executor = {
    isPhotoshopRunning: async () => true,
    launchPhotoshop: async () => { throw new Error('UNEXPECTED_LAUNCH'); },
    execute: async (script) => {
      if (control.executionError) {
        const error = control.executionError;
        control.executionError = null;
        throw error;
      }
      // Each COM script gets a fresh engine global; application options survive.
      const global = {};
      globals.push(global);
      let result;
      try {
        result = runInNewContext(script, {
        $: { global, engineName: 'SS main' }, app, ActionDescriptor,
        stringIDToTypeID: (value) => value, DialogModes: { NO: 'NO' },
        });
      } catch (error) {
        // The VM completed the script, including guard errors; this is not a lost response.
        throw new ScriptExecutionError(error.message, 'finished');
      }
      if (control.responseError) {
        const error = control.responseError;
        control.responseError = null;
        throw error;
      }
      if (typeof result !== 'string') return result;
      try { return JSON.parse(result); } catch { return result; }
    },
  };
  const unscopedApi = async () => new PhotoshopAPIFactory(connection).createAPI();
  const dispatch = async (document = false, script = 'app.operations++; return app.displayDialogs;') => {
    const api = await unscopedApi();
    return connection.withScope({
      ...(document ? { documentId: target.id, documentPath: null, layerId: nestedLayer.id } : {}),
      recheck: async () => { control.rechecks++; },
    }, () => api.executeScript(script));
  };
  return { connection, app, control, options, puts, globals, target, nestedLayer, dispatch, unscopedApi };
}

operationTest('one CustomOptions installation supports repeated inspections and both scoped guards with fresh globals', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await f.connection.inspectDocuments(), [{ id: 99, path: null }, { id: 7, path: null }]);
  }
  assert.equal(await f.dispatch(), 'NO');
  assert.equal(await f.dispatch(true), 'NO');
  assert.equal(f.app.operations, 2);
  assert.equal(f.control.rechecks, 2);
  assert.equal(f.app.activeDocument, f.target);
  assert.equal(f.target.activeLayer, f.nestedLayer);
  assert.equal(f.app.displayDialogs, 'ALL');
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0].persistent, false);
  assert.equal(f.options.get(f.puts[0].key).getString('token'), f.connection.epoch);
  assert.equal(new Set(f.globals).size, f.globals.length);
});

for (const state of ['missing', 'mismatch', 'descriptor-without-token', 'lookup-unavailable']) {
  operationTest(`${state} identity rejects inspection and both guards before operations without reinstalling`, async () => {
    const f = fixture();
    await f.connection.inspectDocuments();
    const key = f.puts[0].key;
    if (state === 'missing') f.options.clear();
    if (state === 'mismatch') f.options.get(key).putString('token', 'another-application-token');
    if (state === 'descriptor-without-token') f.options.set(key, new ActionDescriptor());
    if (state === 'lookup-unavailable') f.control.lookupError = new Error('OPTIONS_UNAVAILABLE');
    const reads = f.control.documentReads;
    const active = f.app.activeDocument;
    await assert.rejects(f.connection.inspectDocuments(), /PHOTOSHOP_SESSION_CHANGED/);
    await assert.rejects(f.dispatch(), /PHOTOSHOP_SESSION_CHANGED/);
    await assert.rejects(f.dispatch(true), /PHOTOSHOP_SESSION_CHANGED/);
    assert.equal(f.control.documentReads, reads);
    assert.equal(f.app.operations, 0);
    assert.equal(f.app.activeDocument, active);
    assert.equal(f.target.activeLayer, undefined);
    assert.equal(f.app.displayDialogs, 'ALL');
    assert.equal(f.control.rechecks, 2);
    assert.equal(f.puts.length, 1);
    assert.equal(f.connection.epochInstalled, true);
  });
}

operationTest('an application restart loses options and a new Connection gets its own identity', async () => {
  const f = fixture();
  await f.connection.inspectDocuments();
  f.options.clear();
  await assert.rejects(f.connection.inspectDocuments(), /PHOTOSHOP_SESSION_CHANGED/);
  await assert.rejects(f.dispatch(true), /PHOTOSHOP_SESSION_CHANGED/);
  const next = new PhotoshopConnection();
  next.detector = f.connection.detector;
  next.executor = f.connection.executor;
  await next.inspectDocuments();
  assert.notEqual(next.epoch, f.connection.epoch);
  assert.equal(f.puts.length, 2);
  assert.notEqual(f.puts[0].key, f.puts[1].key);
  await assert.rejects(f.connection.inspectDocuments(), /PHOTOSHOP_SESSION_CHANGED/);
});

operationTest('lost first response never repeats the completed installation', async () => {
  const f = fixture();
  const error = new ScriptExecutionError('CHANNEL_RESPONSE_LOST', 'unknown');
  f.control.responseError = error;
  await assert.rejects(f.connection.inspectDocuments(), (actual) => actual === error);
  assert.equal(f.connection.epochInstalled, true);
  await assert.rejects(f.connection.inspectDocuments(), /SESSION_FAULTED_RESTART_REQUIRED/);
  await assert.rejects(f.dispatch(true), /SESSION_FAULTED_RESTART_REQUIRED/);
  assert.equal(f.connection.isFaulted, true);
  assert.equal(f.puts.length, 1);
});

operationTest('failed first dispatch does not retry installation and fails closed thereafter', async () => {
  const f = fixture();
  const error = new ScriptExecutionError('CHANNEL_UNAVAILABLE', 'not-started');
  f.control.executionError = error;
  await assert.rejects(f.connection.inspectDocuments(), (actual) => actual === error);
  assert.equal(f.connection.epochInstalled, true);
  await assert.rejects(f.connection.inspectDocuments(), /PHOTOSHOP_SESSION_CHANGED/);
  await assert.rejects(f.dispatch(), /PHOTOSHOP_SESSION_CHANGED/);
  assert.equal(f.puts.length, 0);
  assert.equal(f.app.operations, 0);
});

operationTest('failed installation preserves its error and is not attempted again', async () => {
  const f = fixture();
  f.control.putError = new Error('OPTIONS_WRITE_UNAVAILABLE');
  await assert.rejects(f.connection.inspectDocuments(), /OPTIONS_WRITE_UNAVAILABLE/);
  f.control.putError = null;
  await assert.rejects(f.connection.inspectDocuments(), /PHOTOSHOP_SESSION_CHANGED/);
  assert.equal(f.puts.length, 0);
});

operationTest('unrelated inspection, transport and operation errors propagate without reinstalling', async () => {
  const f = fixture();
  f.control.documentError = new Error('DOCUMENT_ENUMERATION_FAILED');
  await assert.rejects(f.connection.inspectDocuments(), /DOCUMENT_ENUMERATION_FAILED/);
  f.control.documentError = null;
  await f.connection.inspectDocuments();
  const error = new ScriptExecutionError('CHANNEL_FAILURE', 'not-started');
  f.control.executionError = error;
  await assert.rejects(f.dispatch(true), (actual) => actual === error);
  await assert.rejects(f.dispatch(true, "throw new Error('OPERATION_FAILED');"), /OPERATION_FAILED/);
  assert.equal(f.app.displayDialogs, 'ALL');
  await f.dispatch(true);
  assert.equal(f.puts.length, 1);
  assert.equal(f.app.operations, 1);
});

operationTest('scope recheck rejection and document/layer targeting still precede operation', async () => {
  const f = fixture();
  await f.connection.inspectDocuments();
  const api = await f.unscopedApi();
  const error = new Error('GRANT_RECHECK_DENIED');
  const calls = f.globals.length;
  await assert.rejects(f.connection.withScope({ recheck: async () => { throw error; } },
    () => api.executeScript('app.operations++;')), (actual) => actual === error);
  assert.equal(f.globals.length, calls);
  for (const [scope, message] of [
    [{ documentId: 123, documentPath: null }, 'TARGET_DOCUMENT_CHANGED'],
    [{ documentId: 7, documentPath: '/unexpected.psd' }, 'TARGET_PATH_CHANGED'],
    [{ documentId: 7, documentPath: null, layerId: 123 }, 'TARGET_LAYER_CHANGED'],
  ]) {
    await assert.rejects(f.connection.withScope({ ...scope, recheck: async () => {} },
      () => api.executeScript('app.operations++;')), new RegExp(message));
  }
  assert.equal(f.app.operations, 0);
  assert.equal(f.puts.length, 1);
});

operationTest('unscoped version queries and factory creation neither install nor restore identity', async () => {
  const f = fixture();
  assert.equal((await f.connection.getVersionInfo()).canExecuteScript, true);
  await f.unscopedApi();
  await f.unscopedApi();
  assert.equal(f.puts.length, 0);
  assert.equal(f.connection.epochInstalled, false);
  await f.connection.inspectDocuments();
  assert.equal(await f.connection.getVersion(), '26.0');
  assert.equal(await f.connection.ping(), true);
  await f.unscopedApi();
  await f.connection.inspectDocuments();
  f.options.clear();
  assert.equal(await f.connection.ping(), true);
  await f.unscopedApi();
  await assert.rejects(f.connection.inspectDocuments(), /PHOTOSHOP_SESSION_CHANGED/);
  await assert.rejects(f.dispatch(true), /PHOTOSHOP_SESSION_CHANGED/);
  assert.equal(f.puts.length, 1);
  assert.equal(f.connection.epochInstalled, true);
});
