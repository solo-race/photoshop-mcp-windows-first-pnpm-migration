import assert from 'node:assert/strict';
export const NO_RAW_REQUIREMENTS = Object.freeze(['pureStable', 'actionOnlyBracket', 'full64Shape',
  'sourceStateRestored', 'ownedCleanupComplete', 'noOriginalPixelBytesMeasured']);

// Strict projection preserves saved, mask metadata and channel availability.
// Positive allows only saved/histogram changes; PSD compares semantic identities.
export function pureStateProjection(observation, comparison = 'strict') {
  assert.ok(['strict', 'positive', 'psd'].includes(comparison), 'UNKNOWN_PROJECTION');
  const state = JSON.parse(JSON.stringify(observation.state));
  if (comparison !== 'strict') {
    for (const channel of state.allChannels) delete channel.histogram;
    if (state.target?.am) delete state.target.am.histogram;
    delete state.document.saved;
  }
  if (comparison === 'psd') {
    delete state.document.id; delete state.document.name;
    for (const layer of state.layers) delete layer.id;
    return { state };
  }
  const projected = { hasSelection: observation.hasSelection, state, active: observation.active };
  for (const field of ['bounds', 'shape', 'counts'])
    if (Object.hasOwn(observation, field)) projected[field] = observation[field];
  return projected;
}
export function requireNoRawGate(evidence) {
  assert.equal(evidence?.status, 'PASS', 'NO_RAW_GATE_REQUIRED');
  assert.equal(evidence.gate, 'selection-fill-native-no-raw', 'NO_RAW_GATE_REQUIRED');
  assert.equal(evidence.matrixAllowed, true, 'NO_RAW_GATE_REQUIRED');
  assert.deepEqual(evidence.cases?.map(row => row.variant).sort(), ['depth16', 'gray'], 'NO_RAW_GATE_CASES');
  for (const row of evidence.cases) for (const key of NO_RAW_REQUIREMENTS)
    assert.equal(row[key], true, 'NO_RAW_GATE_CRITERION:' + row.variant + ':' + key);
  return evidence;
}
export async function atomicBracket(read, action) {
  const before = await read(), result = action ? await action() : null, after = await read();
  return { before, result, after };
}
export function mismatchLayerPairs(first, second, replacedLayer) {
  assert.notEqual(first.id, second.id, 'DISTINCT_OWNED_DOCUMENTS');
  assert.equal(first.opaque, true, 'OPAQUE_MISMATCH_SETUP_REQUIRED');
  assert.equal(second.opaque, false, 'TRANSPARENT_MISMATCH_SOURCE_PRESERVED');
  assert.ok(Number.isInteger(first.layer) && Number.isInteger(second.layer), 'MISMATCH_LAYER_IDS_GATE');
  assert.notEqual(first.layer, replacedLayer, 'FIRST_LAYER_REPLACEMENT_GATE');
  // Each fixture has exactly one layer; the old first layer was removed by native_fixture.
  assert.notEqual(first.layer, second.layer, 'FOREIGN_LAYER_IDS_GATE');
  return [[first, second], [second, first]];
}
const errorText = result => result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
export async function captureRejectedAction(connection, definition, action, cleanupUnsafe = () => false) {
  const execute = connection.executeScript, handler = definition.handler;
  const scriptErrors = [];
  let result, error, handlerResult, unsafeFailure, didThrow = false;
  connection.executeScript = async function (...parameters) {
    let returned;
    try { returned = await execute.apply(this, parameters); }
    catch (failure) {
      scriptErrors.push(failure.message);
      if (failure.completion === 'unknown' || failure.cleanupFailed) unsafeFailure = failure;
      throw failure;
    }
    // The API unwraps this completed script rejection after executeScript returns.
    // Record its original reason here, then let the API handle the same envelope.
    if (returned && typeof returned === 'object' && returned.ok === false &&
      returned.error && typeof returned.error === 'object' && typeof returned.error.message === 'string')
      scriptErrors.push(returned.error.message);
    return returned;
  };
  definition.handler = async function (...parameters) {
    handlerResult = await handler.apply(this, parameters); return handlerResult;
  };
  try { result = await action(); }
  catch (failure) { error = failure; didThrow = true; }
  finally { connection.executeScript = execute; definition.handler = handler; }
  if (connection.isFaulted || unsafeFailure || error?.completion === 'unknown' || error?.cleanupFailed || cleanupUnsafe())
    throw unsafeFailure ?? error ?? new Error('REJECTION_SESSION_UNSAFE_STOP');
  return { result, error, didThrow, scriptErrors, handlerResult };
}
export function verifyRejection(captured, expected, label) {
  assert.ok(expected, 'MISSING_EXPECTED_REJECTION:' + label);
  const { result, error, didThrow, scriptErrors, handlerResult } = captured;
  let rejection, originalReason;
  if (didThrow) {
    if (!expected.throw || !(error instanceof Error) || error.message !== expected.throw) throw error;
    assert.equal(scriptErrors.length, 0, 'UNEXPECTED_SCRIPT_FAILURE:' + label);
    rejection = error.message;
  } else {
    assert.equal(expected.throw, undefined, 'EXPECTED_ARGUMENT_REJECTION:' + label);
    assert.equal(result.isError, true, 'EXPECTED_REJECTION:' + label);
    rejection = errorText(result);
    assert.equal(rejection, 'PHOTOSHOP_OPERATION_FAILED: inspect the selected document locally; no automatic retry or recovery performed.', 'UNEXPECTED_REJECTION_CODE:' + label);
    if (expected.script) {
      assert.equal(scriptErrors.length, 1, 'MISSING_OR_EXTRA_SCRIPT_FAILURE:' + label);
      originalReason = scriptErrors[0];
      assert.equal(originalReason, expected.script, 'UNEXPECTED_REJECTION_REASON:' + label);
    } else {
      assert.equal(scriptErrors.length, 0, 'UNEXPECTED_SCRIPT_FAILURE:' + label);
      assert.equal(handlerResult?.isError, true, 'EXPECTED_HANDLER_REJECTION:' + label);
      originalReason = errorText(handlerResult);
      assert.equal(originalReason, expected.handler, 'UNEXPECTED_REJECTION_REASON:' + label);
    }
  }
  return { rejection, originalReason };
}
export function maskRejectionReason(observation) {
  const target = observation.state.target;
  assert.equal(target.method, 'mask-AM', 'MASK_GETTER_CAUSE_GATE');
  assert.equal(target.getterError?.phase, 'activeChannels.getter', 'MASK_GETTER_CAUSE_GATE');
  assert.ok(target.getterError.message, 'MASK_GETTER_CAUSE_GATE');
  return 'Fill cannot verify RGB target: ' + target.getterError.message;
}
