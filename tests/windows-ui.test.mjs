import test from 'node:test';
import assert from 'node:assert/strict';
import { toSendKeys } from '../dist/platform/windows-ui.js';

test('toSendKeys maps common shortcuts to SendKeys syntax', () => {
  assert.equal(toSendKeys('ctrl+shift+z'), '^+z');
  assert.equal(toSendKeys('escape'), '{ESC}');
  assert.equal(toSendKeys('f7'), '{F7}');
});
