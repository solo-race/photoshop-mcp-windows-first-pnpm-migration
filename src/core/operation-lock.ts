import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type DispatchCompletion = 'not-started' | 'finished' | 'unknown';
type LockState = { state: 'idle' | 'pending'; owner: string };
type Owner = LockState & { pid: number };

export const operationContext = new AsyncLocalStorage<{
  lock: OperationLock;
  isStopping: () => boolean;
}>();

export class OperationLock {
  private ownsLock = false;
  private fault = false;
  private owner = randomUUID();

  constructor(readonly directory = join(tmpdir(), 'photoshop-mcp-single-writer')) {}

  get faulted(): boolean {
    return this.fault;
  }

  private async createDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700 });
  }

  private async removeDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }

  private async readOwner(): Promise<Owner> {
    try {
      const pidText = (await readFile(join(this.directory, 'pid'), 'utf8')).trim();
      const pid = Number(pidText);
      const state = JSON.parse(await readFile(join(this.directory, 'state'), 'utf8')) as LockState;
      if (
        !/^[1-9][0-9]*$/.test(pidText) ||
        !Number.isSafeInteger(pid) ||
        !state ||
        !['idle', 'pending'].includes(state.state) ||
        typeof state.owner !== 'string' ||
        !state.owner
      )
        throw new Error('WRITER_LOCK_UNCERTAIN');
      return { pid, ...state };
    } catch {
      throw new Error('WRITER_LOCK_UNCERTAIN');
    }
  }

  private isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw new Error('WRITER_LOCK_UNCERTAIN');
    }
  }

  private async requireDeadIdle(): Promise<void> {
    const owner = await this.readOwner();
    if (owner.state !== 'idle') throw new Error('WRITER_LOCK_PENDING');
    if (!this.isDead(owner.pid)) throw new Error('WRITER_LOCK_ACTIVE');
  }

  async acquire(): Promise<void> {
    if (this.fault) throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
    if (this.ownsLock) throw new Error('OPERATION_LOCK_ALREADY_HELD');
    try {
      await this.createDirectory(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('WRITER_LOCK_ACQUIRE_FAILED');
      await this.requireDeadIdle();
      const recovery = this.directory + '.recovery';
      try {
        await this.createDirectory(recovery);
      } catch {
        throw new Error('WRITER_LOCK_RECOVERY_BUSY');
      }
      // Only this successful mkdir grants recovery ownership. Never reclaim it.
      try {
        await writeFile(join(recovery, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
        await this.requireDeadIdle();
        await this.removeDirectory(this.directory);
        // A new owner may win this gap. On failure, never remove or retry its lock.
        try {
          await this.createDirectory(this.directory);
        } catch {
          throw new Error('WRITER_LOCK_RECOVERY_FAILED');
        }
      } finally {
        await this.removeDirectory(recovery);
      }
    }
    this.ownsLock = true;
    try {
      await writeFile(join(this.directory, 'pid'), String(process.pid), {
        flag: 'wx',
        mode: 0o600,
      });
      await writeFile(
        join(this.directory, 'state'),
        JSON.stringify({ state: 'idle', owner: this.owner }),
        {
          flag: 'wx',
          mode: 0o600,
        }
      );
    } catch {
      // This newly created directory has never permitted a dispatch.
      await this.removeDirectory(this.directory);
      this.ownsLock = false;
      throw new Error('WRITER_LOCK_INITIALIZE_FAILED');
    }
  }

  private async verifyOwned(state: LockState['state']): Promise<void> {
    const actual = await this.readOwner();
    if (
      !this.ownsLock ||
      actual.pid !== process.pid ||
      actual.owner !== this.owner ||
      actual.state !== state
    )
      throw new Error('WRITER_LOCK_UNCERTAIN');
  }

  private async writeState(state: LockState['state']): Promise<void> {
    const next = join(this.directory, 'state.next');
    await writeFile(next, JSON.stringify({ state, owner: this.owner }), {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(next, join(this.directory, 'state'));
  }

  async beginDispatch(): Promise<void> {
    if (this.fault) throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
    try {
      await this.verifyOwned('idle');
      await this.writeState('pending');
    } catch {
      this.fault = true;
      throw new Error('WRITER_LOCK_PENDING_WRITE_FAILED');
    }
  }

  async completeDispatch(completion: DispatchCompletion): Promise<void> {
    if (completion === 'unknown') this.fault = true;
    if (this.fault) return;
    try {
      await this.verifyOwned('pending');
      await this.writeState('idle');
    } catch {
      this.fault = true;
      throw new Error('WRITER_LOCK_SETTLEMENT_FAILED');
    }
  }

  async release(): Promise<void> {
    if (!this.ownsLock || this.fault) return;
    try {
      await this.verifyOwned('idle');
      await this.removeDirectory(this.directory);
      this.ownsLock = false;
    } catch {
      this.fault = true;
      throw new Error('WRITER_LOCK_RELEASE_FAILED');
    }
  }
}
