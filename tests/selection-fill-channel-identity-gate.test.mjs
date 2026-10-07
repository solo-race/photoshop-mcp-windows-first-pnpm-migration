import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { GetterBlocked, getterDiagnosticScript, identityReadScript, readIdentity, verifyKnownTargets } from './helpers/selection-fill-channel-identity-gate.mjs';

// Independent producer metadata and local actual outputs; no dist or COM execution.
function fixture() {
  const roster = ['Red', 'Green', 'Blue'].map(name => ({ name, kind: 'component', component: true }));
  const alpha = { name: 'native-alpha', kind: 'masked-area' };
  let target = 'mask', hasAlpha = false;
  const operations = [], getterReads = [], events = [];
  const setTarget = async operation => {
    operations.push(operation);
    target = operation;
    if (operation === 'alpha') hasAlpha = true;
    return { createdAlpha: operation === 'alpha' ? { ...alpha } : undefined };
  };
  const read = async (label, getter) => {
    const mask = target === 'mask', count = hasAlpha ? 5 : 4;
    const am = {
      active: { document_id: 80, layer_id: 2 }, unscoped: true,
      fields: {
        channelName: { present: true, kind: 'string', value: mask ? 'owned-mask' : target === 'alpha' ? alpha.name : 'composite-or-partial' },
        itemIndex: { present: true, kind: 'integer', value: mask ? count : -1 },
        count: { present: true, kind: 'integer', value: count },
        visible: { present: true, kind: 'boolean', value: !mask },
        histogram: { present: true, kind: 'list', value: { count: 256, valueNotRead: true } },
      },
    };
    let actualGetter = null;
    if (getter) {
      getterReads.push(label);
      const channels = target === 'alpha' ? [alpha] : target === 'single' ? [roster[0]]
        : target === 'two' ? roster.slice(0, 2) : roster;
      actualGetter = mask ? { ok: false, error: { message: 'mask getter unavailable', number: 1205, phase: 'activeChannels.getter' } }
        : { ok: true, length: channels.length, channels: channels.map(({ name, kind }) => ({ name, kind })) };
    }
    return { am: { ok: true, value: am }, getter: actualGetter };
  };
  return { documentId: 80, layerId: 2, roster, read, setTarget,
    record: (event, data) => events.push({ event, data }), operations, getterReads, events };
}

test('independent roster distinguishes four targets despite identical composite/partial AM fields; structural mask restoration stays local', async () => {
  const f = fixture();
  const result = await verifyKnownTargets(f);
  assert.equal(result.channelIdentityGatePassed, true);
  assert.equal(result.identityVerified, false);
  assert.equal(result.observerRepairAllowed, false);
  assert.deepEqual(f.getterReads, ['mask-baseline', 'all', 'single', 'two', 'alpha']);
  const restored = f.events.find(e => e.event === 'mask-selected-fields-restored');
  assert.deepEqual([restored.data.fields.itemIndex, restored.data.fields.count], [5, 5]);
});

test('wrong subsets, alpha confusion, missing metadata and same-structure restore mismatch stop with failed output retained', async () => {
  const cases = [
    ['all', a => { a.getter.channels.pop(); a.getter.length--; }, /ACTUAL_TARGET_SET_MISMATCH/],
    ['single', a => { a.getter.channels[0].name = 'Green'; }, /ACTUAL_TARGET_SET_MISMATCH/],
    ['two', a => { a.getter.channels[1].name = 'Blue'; }, /ACTUAL_TARGET_SET_MISMATCH/],
    ['alpha', a => { a.getter.channels[0] = { name: 'native-alpha', kind: 'component' }; }, /ACTUAL_TARGET_SET_MISMATCH/],
    ['all', a => { delete a.getter.channels[0].kind; }, /TYPED_CHANNEL_METADATA_GATE/],
    ['mask-baseline', a => { delete a.am.value.fields.channelName; }, /ACTUAL_CHANNEL_FIELD_GATE/],
    ['mask-baseline', a => { a.am = { ok: false, error: { message: 'mask AM unavailable', number: 1205, phase: 'AM.current-channel' } }; }, /MASK_AM_READ_GATE/],
    ['mask-restored-two', a => { a.am = { ok: false, error: { message: 'mask AM unavailable', number: 1205, phase: 'AM.current-channel' } }; }, /MASK_AM_READ_GATE/],
    ['mask-restored-two', a => { a.am.value.fields.count.value++; }, /MASK_RESTORE_SELECTED_FIELDS_GATE/],
    ['mask-restored-after-alpha', a => { a.am.value.fields.itemIndex.value++; }, /POST_ALPHA_MASK_RESTORE_GATE/],
  ];
  for (const [label, corrupt, expected] of cases) {
    const f = fixture(), originalRead = f.read;
    let stoppedAt;
    f.read = async (current, getter) => {
      const output = await originalRead(current, getter);
      if (current === label) { corrupt(output); stoppedAt = f.operations.length; }
      return output;
    };
    await assert.rejects(verifyKnownTargets(f), expected);
    assert.equal(f.operations.length, stoppedAt, label);
    assert.equal(f.events.at(-1).event, 'actual-output');
    assert.equal(f.events.at(-1).data.label, label);
  }
});

test('two-target getter runs once before AM throws; independent target verification still succeeds', async () => {
  let gets = 0;
  const trace = [];
  const original = Object.assign(new Error('current channel unavailable'), { number: 1205 });
  const document = { id: 80, activeLayer: { id: 2 },
    get fullName() { throw new Error('unsaved'); }, width: { as: () => 8 }, height: { as: () => 8 },
    mode: 'RGB', bitsPerChannel: 8,
    get activeChannels() {
      gets++; trace.push('getter');
      return [{ name: 'Red', kind: 'component' }, { name: 'Green', kind: 'component' }];
    },
  };
  class ActionReference { putEnumerated() {} }
  const actual = JSON.parse(JSON.stringify(vm.runInNewContext('(function(){' + identityReadScript(80, 2) + '})()', {
    app: { activeDocument: document }, DocumentMode: { RGB: 'RGB' }, BitsPerChannelType: { EIGHT: 8 },
    ActionReference, charIDToTypeID: value => value,
    executeActionGet() { trace.push('AM'); throw original; },
  })));
  assert.equal(gets, 1);
  assert.deepEqual(trace, ['getter', 'AM']);
  assert.equal(actual.getter.length, 2);
  assert.deepEqual(actual.am, { ok: false, error: { message: original.message, number: 1205, phase: 'AM.current-channel' } });
  const f = fixture(), originalRead = f.read;
  f.read = async (label, getter) => {
    const output = await originalRead(label, getter);
    return label === 'two' ? actual : output;
  };
  const result = await verifyKnownTargets(f);
  assert.equal(result.channelIdentityGatePassed, true);
  assert.equal(result.observerRepairAllowed, false);
  assert.equal(result.identityVerified, false);
  assert.equal(f.events.find(e => e.event === 'actual-output' && e.data.label === 'two').data.actualOutput, actual);
  assert.ok(f.events.some(e => e.event === 'target-set-verified' && e.data.operation === 'two'));
});

test('exact getter script reads once, retains original error; target failure blocks without another target attempt', async () => {
  let gets = 0;
  const original = Object.assign(new Error('original host getter failure'), { number: 1205 });
  const document = { id: 80, activeLayer: { id: 2 },
    get fullName() { throw new Error('unsaved'); }, width: { as: () => 8 }, height: { as: () => 8 },
    mode: 'RGB', bitsPerChannel: 8,
    get activeChannels() { gets++; throw original; },
  };
  const getter = JSON.parse(JSON.stringify(vm.runInNewContext('(function(){' + getterDiagnosticScript(80, 2) + '})()', {
    app: { activeDocument: document }, DocumentMode: { RGB: 'RGB' }, BitsPerChannelType: { EIGHT: 8 },
  })));
  assert.equal(gets, 1);
  assert.deepEqual(getter, { ok: false, error: { message: original.message, number: 1205, phase: 'activeChannels.getter' } });
  const f = fixture(), originalRead = f.read;
  f.read = async (label, requested) => {
    const actual = await originalRead(label, requested);
    if (label === 'single') actual.getter = getter;
    return actual;
  };
  await assert.rejects(verifyKnownTargets(f), error => error instanceof GetterBlocked && error.originalError === getter.error);
  assert.deepEqual(f.getterReads, ['mask-baseline', 'all', 'single']);
  assert.deepEqual(f.operations, ['all', 'mask', 'single']);
  assert.equal(f.events.at(-1).data.actualOutput.getter, getter);
});

test('owned, grant/recheck and session refusal execute no readonly identity script', async () => {
  for (const refusal of ['owned', 'grant', 'grant-recheck', 'session']) {
    let factories = 0, executions = 0, grants = 0;
    const connection = {
      inspectDocuments: async () => [{ id: 80 }],
      withScope: async ({ recheck }, execute) => {
        if (refusal === 'session') throw new Error('SESSION_STOP');
        await recheck();
        return execute();
      },
    };
    const projects = { unchanged: async () => {}, grant() {
      grants++;
      if (refusal === 'grant' || (refusal === 'grant-recheck' && grants === 2)) throw new Error('GRANT_STOP');
    } };
    class FakeFactory {
      async createAPI() { factories++; return { executeScript: async () => { executions++; } }; }
    }
    await assert.rejects(readIdentity({ connection, projects, project: {}, getter: true,
      owned: new Set(refusal === 'owned' ? [] : [80]), documentId: 80, layerId: 2,
      PhotoshopAPIFactory: FakeFactory, toExtendScriptValue: String }), /UNOWNED_DOCUMENT|GRANT_STOP|SESSION_STOP/);
    assert.equal(factories, 0, refusal);
    assert.equal(executions, 0, refusal);
  }
});
