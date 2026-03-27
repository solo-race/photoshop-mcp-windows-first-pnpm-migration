import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActionListResponse } from '../dist/tools/action-tools.js';

test('parseActionListResponse parses Photoshop action records', () => {
  const parsed = parseActionListResponse(
    'Set A||Action One||1||1@@@Set B||Action Two||2||3'
  );

  assert.deepEqual(parsed, [
    {
      actionSetName: 'Set A',
      actionName: 'Action One',
      actionSetIndex: 1,
      actionIndex: 1,
    },
    {
      actionSetName: 'Set B',
      actionName: 'Action Two',
      actionSetIndex: 2,
      actionIndex: 3,
    },
  ]);
});

test('parseActionListResponse ignores empty records', () => {
  const parsed = parseActionListResponse('@@@');
  assert.deepEqual(parsed, []);
});
