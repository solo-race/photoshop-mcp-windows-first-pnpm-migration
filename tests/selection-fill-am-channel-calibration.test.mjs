import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAndRestore, readActualChannel } from './helpers/selection-fill-am-channel-calibration.mjs';

// Local producers and descriptors only: no dist imports, process launches or COM.
function fixture() {
  const channels = ['R', 'G', 'B', 'owned-mask'];
  let target = 'owned-mask';
  const events = [], operations = [];
  const setTarget = async operation => {
    operations.push(operation);
    if (operation === 'alpha') {
      channels.splice(3, 0, 'native-alpha');
      target = 'native-alpha';
    } else target = operation === 'mask' ? 'owned-mask' : 'recorded-composite';
    return { knownInputOnly: true, identityVerified: false };
  };
  const read = async () => ({
    active: { document_id: 72, layer_id: 2 }, unscoped: true, identityVerified: false,
    fields: {
      channelName: { present: true, kind: 'string', value: target },
      itemIndex: { present: true, kind: 'integer', value: target === 'recorded-composite' ? 19 : channels.indexOf(target) + 1 },
      count: { present: true, kind: 'integer', value: channels.length },
      visible: { present: true, kind: 'boolean', value: target !== 'owned-mask' },
      histogram: { present: true, kind: 'list', value: { count: 256, valueNotRead: true } },
    },
  });
  return { documentId: 72, layerId: 2, read, setTarget,
    record: (event, data) => events.push({ event, data }), events, operations };
}

test('alpha producer changes mask index/count; restoration compares within the new structure', async () => {
  const f = fixture();
  await discoverAndRestore(f);
  const restored = f.events.filter(e => e.event === 'mask-selected-fields-restored');
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map(e => [e.data.fields.itemIndex, e.data.fields.count]), [[4, 4], [5, 5]]);
  assert.ok(restored.every(e => e.data.identityVerified === false));
  const actual = f.events.filter(e => e.event === 'actual-output');
  assert.ok(actual.every(e => e.data.actualOutput.identityVerified === false));
  assert.equal(actual.find(e => e.data.label === 'known-rgb-before-alpha').data.actualOutput.fields.itemIndex.value, 19);
});

test('missing/type fields, identity confusion and same-structure restore mismatch stop before further mutations', async () => {
  const cases = [
    ['known-rgb-before-alpha', a => { delete a.fields.channelName; }, /ACTUAL_CHANNEL_FIELD_GATE/],
    ['known-rgb-before-alpha', a => { a.fields.itemIndex.kind = 'string'; }, /ACTUAL_CHANNEL_FIELD_GATE/],
    ['known-rgb-before-alpha', a => { a.active.document_id = 999; }, /OWNED_ACTIVE_TARGET_CHANGED/],
    ['known-created-alpha', a => { a.fields.channelName.value = 'owned-mask'; }, /CREATED_ALPHA_NAME_GATE/],
    ['mask-baseline-after-alpha', a => { a.fields.channelName.value = 'native-alpha'; }, /POST_ALPHA_MASK_NAME_GATE/],
    ['mask-restored-before-alpha', a => { a.fields.count.value++; }, /MASK_RESTORE_SELECTED_FIELDS_GATE/],
    ['mask-restored-after-alpha', a => { a.fields.itemIndex.value++; }, /MASK_RESTORE_AFTER_ALPHA_SELECTED_FIELDS_GATE/],
  ];
  for (const [label, corrupt, expected] of cases) {
    const f = fixture(), originalRead = f.read;
    let operationsAtFailure;
    f.read = async current => {
      const actual = await originalRead();
      if (current === label) { corrupt(actual); operationsAtFailure = f.operations.length; }
      return actual;
    };
    await assert.rejects(discoverAndRestore(f), expected);
    assert.equal(f.operations.length, operationsAtFailure, label);
    assert.equal(f.events.at(-1).event, 'actual-output');
    assert.equal(f.events.at(-1).data.label, label); // Failed output remains evidence.
  }
});

test('owned, grant/recheck and session refusal dispatch no actual-channel script', async () => {
  for (const refusal of ['owned', 'grant', 'grant-recheck', 'session']) {
    let dispatches = 0, factories = 0, grants = 0;
    const connection = {
      inspectDocuments: async () => [{ id: 72 }],
      withScope: async ({ recheck }, execute) => {
        if (refusal === 'session') throw new Error('SESSION_STOP');
        await recheck();
        return execute();
      },
    };
    const projects = {
      unchanged: async () => {},
      grant() {
        grants++;
        if (refusal === 'grant' || (refusal === 'grant-recheck' && grants === 2)) throw new Error('GRANT_STOP');
      },
    };
    class FakeFactory {
      async createAPI() { factories++; return { executeScript: async () => { dispatches++; } }; }
    }
    await assert.rejects(readActualChannel({ connection, projects, project: {},
      owned: new Set(refusal === 'owned' ? [] : [72]), documentId: 72, layerId: 2,
      PhotoshopAPIFactory: FakeFactory, toExtendScriptValue: String }), /UNOWNED_DOCUMENT|GRANT_STOP|SESSION_STOP/);
    assert.equal(factories, 0, refusal);
    assert.equal(dispatches, 0, refusal);
  }
});
