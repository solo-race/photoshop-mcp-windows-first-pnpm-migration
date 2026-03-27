import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import { ScriptExecutor } from './script-executor.js';

const execAsync = promisify(exec);

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private scriptQueue: Array<() => Promise<unknown>> = [];
  private isProcessing = false;

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout: number = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.scriptQueue.push(async () => {
        try {
          const result = await this.executeScript(script, timeout);
          resolve(result);
          return result;
        } catch (error) {
          reject(error);
          throw error;
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

  private async executeScript(script: string, timeout: number): Promise<unknown> {
    // For Windows, we'll use a combination of VBScript/JScript to communicate with Photoshop via COM
    // Write script to temporary file
    const tempScriptPath = join(tmpdir(), `photoshop-script-${Date.now()}.jsx`);
    
    try {
      await writeFile(tempScriptPath, script, 'utf8');

      // Use VBScript to execute the JSX script via COM
      const vbsScript = this.createVBSWrapper(tempScriptPath);
      const vbsPath = join(tmpdir(), `photoshop-vbs-${Date.now()}.vbs`);
      
      await writeFile(vbsPath, vbsScript, 'utf8');

      try {
        return await this.runVbsScript(vbsPath, timeout);
      } finally {
        // Cleanup VBS file
        await unlink(vbsPath).catch(() => {});
      }
    } finally {
      // Cleanup JSX file
      await unlink(tempScriptPath).catch(() => {});
    }
  }

  private createVBSWrapper(jsxPath: string): string {
    return `
On Error Resume Next
Dim photoshopApp
Set photoshopApp = CreateObject("Photoshop.Application")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: Failed to connect to Photoshop - " & Err.Description
    WScript.Quit 1
End If

' Execute the JSX script
Dim result
result = photoshopApp.DoJavaScript("$.evalFile('" & Replace("${jsxPath}", "\\", "\\\\") & "');")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 1
Else
    WScript.Echo result
End If
`.trim();
  }

  private async runVbsScript(vbsPath: string, timeout: number): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const child = spawn('cscript', ['//nologo', vbsPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

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
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        settle(error instanceof Error ? error : new Error(String(error)));
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
          settle(new Error(message));
          return;
        }

        try {
          settle(null, this.parseResult(stdout));
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });

      const timeoutId = setTimeout(() => {
        this.logger.warn(`Script execution timed out after ${timeout}ms`);
        void this.terminateProcessTree(child.pid);
        settle(new Error('Script execution timeout'));
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
      throw new Error(trimmed.substring(6).trim());
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
    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq Photoshop.exe"');
      return stdout.toLowerCase().includes('photoshop.exe');
    } catch (_error) {
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info(`Launching Photoshop: ${photoshopPath}`);

      const child = spawn(photoshopPath, [], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      // Wait a bit for Photoshop to start
      setTimeout(() => {
        resolve();
      }, 5000);

      child.on('error', (error) => {
        reject(new Error(`Failed to launch Photoshop: ${error.message}`));
      });
    });
  }
}
