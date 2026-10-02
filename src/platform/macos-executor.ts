import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptExecutor } from './script-executor.js';
import { toExtendScriptValue } from '../core/serializer.js';
const run = promisify(execFile);
const appleString = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
export class MacOSExecutor implements ScriptExecutor {
  private appName = 'Adobe Photoshop 2025';
  setAppName(value: string): void {
    if (!/^Adobe Photoshop[ a-zA-Z0-9.()-]*$/.test(value))
      throw new Error('INVALID_APPLICATION_NAME');
    this.appName = value;
  }
  async execute(script: string, timeout = 30000): Promise<unknown> {
    if (!(await this.isPhotoshopRunning())) throw new Error('Open Photoshop manually');
    const directory = await mkdtemp(join(tmpdir(), 'photoshop-mcp-'));
    try {
      const jsx = join(directory, 'operation.jsx');
      const as = join(directory, 'operation.applescript');
      await writeFile(jsx, script, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const operation = `$.evalFile(${toExtendScriptValue(jsx)})`;
      // No activate, shell interpolation or implicit launch fallback.
      await writeFile(
        as,
        `if application ${appleString(this.appName)} is not running then error "Open Photoshop manually"\ntell application ${appleString(this.appName)}\n do javascript ${appleString(operation)}\nend tell`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
      const { stdout } = await run('osascript', [as], { timeout, maxBuffer: 4 * 1024 * 1024 });
      try {
        return JSON.parse(stdout.trim());
      } catch {
        return stdout.trim();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async isPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await run('pgrep', ['-f', 'Adobe Photoshop'], { timeout: 5000 });
      return !!stdout.trim();
    } catch {
      return false;
    }
  }
  async launchPhotoshop(_path: string): Promise<void> {
    throw new Error('Automatic launch disabled');
  }
}
