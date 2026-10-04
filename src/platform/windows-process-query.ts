import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Enumerate with terminating errors: a failed query must not become zero matches.
const command = `$ErrorActionPreference = 'Stop';
try {
  $photoshopProcesses = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq 'Photoshop' });
  if ($photoshopProcesses.Count -gt 0) { [Console]::Out.WriteLine('1') }
  else { [Console]::Out.WriteLine('0') }
} catch { exit 1 }`;

export class WindowsProcessQueryError extends Error {
  readonly completion = 'not-started' as const;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'WindowsProcessQueryError';
  }
}

export class WindowsProcessQuery {
  private run = promisify(execFile);

  async isPhotoshopRunning(): Promise<boolean> {
    let firstFailure: unknown;
    for (const executable of ['powershell.exe', 'pwsh']) {
      let stdout: string;
      try {
        const result = await this.run(
          executable,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }
        );
        stdout = result.stdout;
      } catch (error) {
        if (executable === 'powershell.exe') {
          firstFailure = error;
          continue;
        }
        throw new WindowsProcessQueryError(
          'PHOTOSHOP_RUNNING_QUERY_FAILED',
          new AggregateError([firstFailure, error], 'RUNNING_QUERY_ATTEMPTS_FAILED')
        );
      }
      const output = stdout.trim();
      if (output === '0') return false;
      if (output === '1') return true;
      // Successful but malformed output is not evidence for retry or not-running.
      const invalidOutput = new Error('RUNNING_QUERY_OUTPUT_NOT_BOOLEAN');
      throw new WindowsProcessQueryError(
        'PHOTOSHOP_RUNNING_QUERY_INVALID_OUTPUT',
        executable === 'pwsh'
          ? new AggregateError([firstFailure, invalidOutput], 'RUNNING_QUERY_ATTEMPTS_FAILED')
          : invalidOutput
      );
    }
    throw new WindowsProcessQueryError('PHOTOSHOP_RUNNING_QUERY_FAILED', firstFailure);
  }
}
