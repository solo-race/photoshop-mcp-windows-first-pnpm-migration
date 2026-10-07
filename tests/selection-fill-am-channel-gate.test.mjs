import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { channelScript } from './helpers/selection-fill-am-channel-gate.mjs';

// Execute the exact generated discovery script with local AM stubs only.
// These cases distinguish failure phases; they do not establish Photoshop semantics.
function unknown() {
  return Object.assign(new Error('fixture unknown exception'), { number: 1205 });
}

function probe({ terminal = 'throw', actionError = false, descriptorError = false,
  descriptorReference = false, descriptorScalar = false, descriptorBudget = false,
  descriptorEntries, metadataError, fault, terminalNumber = 1205 } = {}) {
  let actionReads = 0, desiredClassReads = 0;
  const complexReads = { reference: 0, objectValue: 0, listItems: 0, listMetadata: 0 };
  const forms = { ENUMERATED: 'enumerated', IDENTIFIER: 'identifier' };
  function reference(items, end = terminal, index = 0) {
    const fail = (getter) => {
      if (fault?.getter === getter && fault.depth === index)
        throw Object.assign(unknown(), { number: fault.number ?? 1205 });
    };
    return {
      getDesiredClass() {
        desiredClassReads++;
        fail('getDesiredClass');
        if (!items[index]) throw Object.assign(unknown(), { number: terminalNumber });
        return items[index].desiredClass;
      },
      getForm() {
        fail('getForm');
        if (!items[index]) throw unknown();
        return items[index].form;
      },
      getEnumeratedType: () => items[index].type,
      getEnumeratedValue() { fail('getEnumeratedValue'); return items[index].value; },
      getIdentifier: () => items[index].value,
      getContainer() {
        fail('getContainer');
        if (index + 1 < items.length) return reference(items, end, index + 1);
        if (end === 'throw') throw unknown();
        if (end === 'empty-form') return {
          getDesiredClass: () => 'empty-class',
          getForm() { throw unknown(); },
        };
        return reference([], end);
      },
    };
  }
  class ActionReference {
    constructor() { this.items = []; }
    putEnumerated(desiredClass, type, value) {
      this.items.push({ desiredClass, form: forms.ENUMERATED, type, value });
    }
    putIdentifier(desiredClass, value) {
      this.items.push({ desiredClass, form: forms.IDENTIFIER, value });
    }
    getDesiredClass() { return reference(this.items).getDesiredClass(); }
    getForm() { return reference(this.items).getForm(); }
    getEnumeratedType() { return reference(this.items).getEnumeratedType(); }
    getEnumeratedValue() { return reference(this.items).getEnumeratedValue(); }
    getIdentifier() { return reference(this.items).getIdentifier(); }
    getContainer() { return reference(this.items).getContainer(); }
  }
  const descriptor = {
    count: descriptorEntries?.length ?? (descriptorBudget ? 513 : descriptorError || descriptorReference || descriptorScalar ? 1 : 0),
    getKey(index) { if (descriptorError) throw unknown(); return descriptorEntries?.[index].key ?? 'stub-reference-key'; },
    getType(key) {
      if (metadataError === 'type') throw unknown();
      return descriptorEntries?.find(entry => entry.key === key).type ?? (descriptorScalar || descriptorBudget ? 'string' : 'reference');
    },
    getString() { if (metadataError === 'scalar') throw unknown(); return 'actual descriptor fixture value'; },
    getReference() { complexReads.reference++; return reference([
      { desiredClass: 'stub-channel', form: forms.IDENTIFIER, value: 7 },
    ], 'empty-class'); },
    getObjectType() { if (metadataError === 'object') throw unknown(); return 'stub-object-class'; },
    getObjectValue() { complexReads.objectValue++; throw unknown(); },
    getList() {
      complexReads.listMetadata++;
      if (metadataError === 'list') throw unknown();
      return {
        get count() { if (metadataError === 'list-count') throw unknown(); return 128; },
        getType() { complexReads.listItems++; throw unknown(); },
      };
    },
  };
  const document = {
    id: 4086, activeLayer: { id: 2 },
    get fullName() { throw new Error('unsaved fixture'); },
    width: { as: () => 8 }, height: { as: () => 8 }, mode: 'RGB', bitsPerChannel: 8,
  };
  const result = vm.runInNewContext('(function(){' + channelScript(4086, 2) + '})()', {
    app: { activeDocument: document },
    DocumentMode: { RGB: 'RGB' }, BitsPerChannelType: { EIGHT: 8 },
    ActionReference, ReferenceFormType: forms,
    DescValueType: { REFERENCETYPE: 'reference', STRINGTYPE: 'string', LISTTYPE: 'list', OBJECTTYPE: 'object' },
    charIDToTypeID: value => value,
    typeIDToStringID: value => String(value), typeIDToCharID: value => String(value),
    executeActionGet() { actionReads++; if (actionError) throw unknown(); return descriptor; },
  });
  return { result: JSON.parse(JSON.stringify(result)), actionReads, desiredClassReads, complexReads };
}

test('evidenced empty input tail completes formatting and retains terminal reason', () => {
    const { result, actionReads } = probe({ terminal: 'empty-class' });
    assert.equal(actionReads, 3);
    result.candidates.forEach((row, index) => {
      const depth = index === 0 ? 2 : 1;
      assert.equal(row.ok, true);
      assert.deepEqual(row.executeActionGet, { started: true, succeeded: true });
      assert.equal(row.error, undefined);
      assert.equal(row.value.reference.length, depth);
      assert.deepEqual(row.value.descriptor, { count: 0, keys: [], inventoryOnly: true, identityVerified: false });
      assert.deepEqual(row.referenceTrace.at(-1), {
        source: 'input', depth, terminal: 'empty-returned',
        error: { message: 'fixture unknown exception', number: 1205 },
      });
      assert.equal(row.referenceTrace.at(-2).container, 'returned');
      assert.equal(row.referenceTrace.at(-2).depth, depth - 1);
    });
});

test('a returned nonempty tail cannot be mistaken for the evidenced empty tail', () => {
  const { result } = probe({ terminal: 'empty-form' });
  result.candidates.forEach((row, index) => {
    assert.equal(row.ok, false);
    assert.equal(row.executeActionGet.succeeded, true);
    assert.equal(row.error.phase, `format.reference.input[${index === 0 ? 2 : 1}].getDesiredClass`);
    assert.equal(row.error.message, 'AM_REFERENCE_LENGTH_GATE');
    assert.equal(row.error.number, null);
  });
});

test('first-node desiredClass, form and value getter errors remain STOP', () => {
  for (const [getter, phase] of [
    ['getDesiredClass', 'getDesiredClass'], ['getForm', 'getForm'],
    ['getEnumeratedValue', 'value'],
  ]) {
    const { result } = probe({ terminal: 'empty-class', fault: { getter, depth: 0 } });
    for (const row of result.candidates.slice(0, getter === 'getEnumeratedValue' ? 2 : 3)) {
      assert.equal(row.ok, false);
      assert.equal(row.executeActionGet.succeeded, true);
      assert.equal(row.error.phase, `format.reference.input[0].${phase}`);
      assert.equal(row.error.number, 1205);
      assert.equal(row.error.message, 'fixture unknown exception');
    }
  }
});

test('nonterminal desiredClass and getContainer 1205 remain STOP', () => {
  for (const [getter, depth] of [['getDesiredClass', 1], ['getContainer', 0]]) {
    const { result } = probe({ terminal: 'empty-class', fault: { getter, depth } });
    const row = result.candidates[0];
    assert.equal(row.ok, false);
    assert.equal(row.executeActionGet.succeeded, true);
    assert.equal(row.error.phase, `format.reference.input[${depth}].${getter}`);
    assert.equal(row.error.number, 1205);
    assert.equal(row.error.message, 'fixture unknown exception');
  }
});

test('unexpected terminal or getContainer error numbers remain STOP', () => {
  for (const options of [
    { terminal: 'empty-class', terminalNumber: 1206 },
    { fault: { getter: 'getContainer', depth: 0, number: 1206 } },
  ]) {
    const { result } = probe(options);
    for (const row of result.candidates) {
      assert.equal(row.ok, false);
      assert.equal(row.executeActionGet.succeeded, true);
      assert.equal(row.error.number, 1206);
      assert.equal(row.error.message, 'fixture unknown exception');
    }
  }
});

test('executeActionGet 1205 is distinguishable without any formatter reads', () => {
  const { result, actionReads, desiredClassReads } = probe({ actionError: true });
  assert.equal(actionReads, 3);
  assert.equal(desiredClassReads, 0);
  for (const row of result.candidates) {
    assert.equal(row.ok, false);
    assert.deepEqual(row.executeActionGet, { started: true, succeeded: false });
    assert.deepEqual(row.error, {
      phase: 'executeActionGet', message: 'fixture unknown exception', number: 1205,
    });
    assert.deepEqual(row.referenceTrace, []);
  }
});

test('existing throwing-getContainer termination retains the complete reference chain', () => {
  const { result, actionReads } = probe();
  assert.equal(actionReads, 3);
  assert.deepEqual(result.active, { document_id: 4086, layer_id: 2 });
  assert.equal(result.readOnly, true);
  result.candidates.forEach((row, index) => {
    assert.equal(row.ok, true);
    assert.deepEqual(row.executeActionGet, { started: true, succeeded: true });
    assert.equal(row.value.reference.length, index === 0 ? 2 : 1);
    assert.deepEqual(row.value.descriptor, { count: 0, keys: [], inventoryOnly: true, identityVerified: false });
    const end = row.referenceTrace.at(-1);
    assert.equal(end.container, 'threw');
    assert.equal(end.error.number, 1205);
  });
});

test('descriptor formatting 1205 is distinct from input-reference formatting', () => {
  const { result } = probe({ terminal: 'empty-class', descriptorError: true });
  for (const row of result.candidates) {
    assert.equal(row.ok, false);
    assert.equal(row.executeActionGet.succeeded, true);
    assert.equal(row.error.phase, 'format.descriptor[0].getKey');
    assert.equal(row.error.number, 1205);
    assert.ok(row.value.reference.length > 0);
  }
});

test('empty input tail still reads actual scalar values without claiming channel identity', () => {
  const { result } = probe({ terminal: 'empty-class', descriptorScalar: true });
  for (const row of result.candidates) {
    assert.equal(row.ok, true);
    assert.equal(row.value.descriptor.count, 1);
    assert.equal(row.value.descriptor.keys.length, 1);
    assert.equal(row.value.descriptor.keys[0].value, 'actual descriptor fixture value');
    assert.equal(row.value.descriptor.inventoryOnly, true);
    assert.equal(row.value.descriptor.identityVerified, false);
  }
});

test('descriptor budget still stops formatting after an accepted empty input tail', () => {
  const { result } = probe({ terminal: 'empty-class', descriptorBudget: true });
  for (const row of result.candidates) {
    assert.equal(row.ok, false);
    assert.equal(row.executeActionGet.succeeded, true);
    assert.equal(row.error.phase, 'format.descriptor');
    assert.equal(row.error.message, 'AM_DESCRIPTOR_BUDGET_GATE');
    assert.equal(row.value.descriptor.keys.length, 512);
  }
});

test('unrelated descriptor references stay unread without assuming a terminal contract', () => {
  const { result, complexReads } = probe({ descriptorReference: true });
  for (const row of result.candidates) {
    assert.equal(row.ok, true);
    assert.equal(row.executeActionGet.succeeded, true);
    assert.ok(row.value.reference.length > 0);
    assert.deepEqual(row.value.descriptor.keys[0].value, { valueNotRead: true });
    assert.equal(row.value.descriptor.identityVerified, false);
    assert.ok(row.referenceTrace.every(entry => entry.source === 'input'));
  }
  assert.equal(complexReads.reference, 0);
});

test('top-level inventory records complex metadata but never traverses large lists or objects', () => {
  const entries = [
    { key: 'fixture-list-key', type: 'list' },
    { key: 'fixture-object-key', type: 'object' },
    { key: 'fixture-reference-key', type: 'reference' },
    { key: 'fixture-string-key', type: 'string' },
  ];
  const { result, complexReads } = probe({ terminal: 'empty-class', descriptorEntries: entries });
  assert.equal(result.inventoryOnly, true);
  assert.equal(result.identityVerified, false);
  for (const row of result.candidates) {
    assert.equal(row.ok, true);
    const inventory = row.value.descriptor;
    assert.equal(inventory.count, 4);
    assert.deepEqual(inventory.keys.map(entry => ({ key: entry.key.id, type: entry.type })), entries);
    assert.deepEqual(inventory.keys[0].value, { count: 128, valueNotRead: true });
    assert.equal(inventory.keys[1].value.class.id, 'stub-object-class');
    assert.equal(inventory.keys[1].value.valueNotRead, true);
    assert.deepEqual(inventory.keys[2].value, { valueNotRead: true });
    assert.equal(inventory.keys[3].value, 'actual descriptor fixture value');
    assert.equal(inventory.identityVerified, false);
  }
  assert.deepEqual(complexReads, { reference: 0, objectValue: 0, listItems: 0, listMetadata: 3 });
});

test('inventory metadata and scalar errors remain STOP with exact phase and original reason', () => {
  for (const [metadataError, type, phase] of [
    ['type', 'list', 'getType'], ['list', 'list', 'value'],
    ['list-count', 'list', 'value'], ['object', 'object', 'value'],
    ['scalar', 'string', 'value'],
  ]) {
    const { result } = probe({ descriptorEntries: [{ key: 'fixture-error-key', type }], metadataError });
    for (const row of result.candidates) {
      assert.equal(row.ok, false);
      assert.equal(row.executeActionGet.succeeded, true);
      assert.equal(row.error.phase, 'format.descriptor[0].' + phase);
      assert.equal(row.error.number, 1205);
      assert.equal(row.error.message, 'fixture unknown exception');
      assert.equal(row.value.descriptor.keys.length, phase === 'getType' ? 0 : 1);
      if (phase === 'value') {
        assert.equal(row.value.descriptor.keys[0].key.id, 'fixture-error-key');
        assert.equal(row.value.descriptor.keys[0].type, type);
        assert.equal(row.value.descriptor.keys[0].value, undefined);
      }
    }
  }
});
