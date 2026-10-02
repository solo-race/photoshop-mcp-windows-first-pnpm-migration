import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('Windows UI and Action execution implementations are removed', () => {
  assert.equal(existsSync(new URL('../src/platform/windows-ui.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/tools/action-tools.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../scripts/real-tool-smoke.mjs', import.meta.url)), false);
  const code = readFileSync(new URL('../src/tools/advanced-tools.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /SendKeys|sendShortcut|toSendKeys|CopyFromScreen|executeRawScript/);
});
