import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import { ScriptExecutor } from './script-executor.js';
import { operationContext, type DispatchCompletion } from '../core/operation-lock.js';
import { WindowsProcessQuery } from './windows-process-query.js';

const execAsync = promisify(exec);

export class ScriptExecutionError extends Error {
  constructor(
    message: string,
    readonly completion: DispatchCompletion
  ) {
    super(message);
    this.name = 'ScriptExecutionError';
  }
}

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private processQuery = new WindowsProcessQuery();
  private scriptQueue: Array<() => Promise<unknown>> = [];
  private isProcessing = false;
  private faulted = false;

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout: number = 30000): Promise<unknown> {
    const isStopping = operationContext.getStore()?.isStopping;
    return new Promise((resolve, reject) => {
      this.scriptQueue.push(async () => {
        try {
          if (this.faulted)
            throw new ScriptExecutionError('SESSION_FAULTED_RESTART_REQUIRED', 'unknown');
          const result = await this.executeScript(script, timeout, isStopping);
          resolve(result);
          return result;
        } catch (error) {
          const classified =
            error instanceof ScriptExecutionError
              ? error
              : new ScriptExecutionError('SCRIPT_EXECUTION_FAILED', 'unknown');
          if (classified.completion === 'unknown') this.faulted = true;
          reject(classified);
          throw classified;
        }
      });

      void this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.scriptQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.scriptQueue.length > 0) {
      const task = this.scriptQueue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          this.logger.error('Script execution failed:', error);
        }
      }
    }

    this.isProcessing = false;
  }

  private async executeScript(
    script: string,
    timeout: number,
    isStopping?: () => boolean
  ): Promise<unknown> {
    let directory: string | undefined;
    let completion: DispatchCompletion = 'not-started';
    let failure: ScriptExecutionError | undefined;
    let result: unknown;
    try {
      directory = await mkdtemp(join(tmpdir(), 'photoshop-mcp-'));
      const tempScriptPath = join(directory, 'operation.jsx');
      const vbsPath = join(directory, 'operation.vbs');
      await writeFile(tempScriptPath, script, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(vbsPath, this.createVBSWrapper(tempScriptPath), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      completion = 'unknown';
      result = await this.runVbsScript(vbsPath, timeout, isStopping);
      completion = 'finished';
    } catch (error) {
      failure =
        error instanceof ScriptExecutionError
          ? error
          : new ScriptExecutionError('SCRIPT_EXECUTION_FAILED', completion);
    }
    if (directory) {
      try {
        await this.removeTempDirectory(directory);
      } catch {
        // A cleanup failure must never replace the original execution failure.
        if (!failure) failure = new ScriptExecutionError('SCRIPT_CLEANUP_FAILED', completion);
        else this.logger.warn('Script temporary directory cleanup failed');
      }
    }
    if (failure) throw failure;
    return result;
  }

  private async removeTempDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }

  private spawnScriptProcess(vbsPath: string) {
    return spawn('cscript', ['//nologo', vbsPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private createVBSWrapper(jsxPath: string): string {
    return `
On Error Resume Next
Dim photoshopApp
Set photoshopApp = GetObject(, "Photoshop.Application")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: Failed to connect to Photoshop - " & Err.Description
    WScript.Quit 1
End If

' Execute the JSX script
Dim result
result = photoshopApp.DoJavaScriptFile("${jsxPath.replace(/"/g, '""')}")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 1
Else
    WScript.Echo result
End If
`.trim();
  }

  private async runVbsScript(
    vbsPath: string,
    timeout: number,
    isStopping?: () => boolean
  ): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      // File preparation awaited after the connection's check. Recheck without
      // yielding between this decision and creating the dispatch process.
      if (isStopping?.()) {
        reject(new ScriptExecutionError('SERVER_STOPPING', 'not-started'));
        return;
      }
      let child: ReturnType<WindowsExecutor['spawnScriptProcess']>;
      try {
        child = this.spawnScriptProcess(vbsPath);
      } catch {
        reject(new ScriptExecutionError('SCRIPT_SPAWN_FAILED', 'not-started'));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let started = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const settle = (error: Error | null, value?: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);

        if (error) {
          reject(error);
          return;
        }

        resolve(value);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 4 * 1024 * 1024) {
          void this.terminateProcessTree(child.pid);
          settle(new ScriptExecutionError('OUTPUT_LIMIT', 'unknown'));
        }
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 1024 * 1024) {
          void this.terminateProcessTree(child.pid);
          settle(new ScriptExecutionError('OUTPUT_LIMIT', 'unknown'));
        }
      });

      child.on('spawn', () => {
        started = true;
      });
      child.on('error', () => {
        settle(
          new ScriptExecutionError(
            'SCRIPT_PROCESS_FAILED',
            !started && child.pid === undefined ? 'not-started' : 'unknown'
          )
        );
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        const trimmedStderr = stderr.trim();
        if (trimmedStderr) {
          this.logger.warn('Script execution warning:', trimmedStderr);
        }

        if (code !== 0) {
          const message =
            trimmedStderr || stdout.trim() || `cscript exited with code ${code ?? 'unknown'}`;
          settle(new ScriptExecutionError(message, 'unknown'));
          return;
        }

        try {
          settle(null, this.parseResult(stdout));
        } catch (error) {
          settle(
            error instanceof ScriptExecutionError
              ? error
              : new ScriptExecutionError('SCRIPT_RESPONSE_FAILED', 'unknown')
          );
        }
      });

      timeoutId = setTimeout(() => {
        this.logger.warn(`Script execution timed out after ${timeout}ms`);
        void this.terminateProcessTree(child.pid);
        settle(new ScriptExecutionError('Script execution timeout', 'unknown'));
      }, timeout);
    });
  }

  private async terminateProcessTree(pid?: number): Promise<void> {
    if (!pid) {
      return;
    }

    try {
      await execAsync(`taskkill /PID ${pid} /T /F`);
    } catch (error) {
      this.logger.warn('Failed to terminate timed-out script process', error);
    }
  }

  private parseResult(output: string): unknown {
    const trimmed = output.trim();

    // Check for error
    if (trimmed.startsWith('ERROR:')) {
      throw new ScriptExecutionError(trimmed.substring(6).trim(), 'unknown');
    }

    // Try to parse as JSON
    try {
      return JSON.parse(trimmed);
    } catch {
      // Return as string if not JSON
      return trimmed;
    }
  }

  async isPhotoshopRunning(): Promise<boolean> {
    return await this.processQuery.isPhotoshopRunning();
  }

  async launchPhotoshop(_photoshopPath: string): Promise<void> {
    throw new Error('Automatic launch disabled');
  }
}
