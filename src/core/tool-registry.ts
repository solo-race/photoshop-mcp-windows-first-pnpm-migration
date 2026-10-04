import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolPolicy, disabledTools } from '../security/tool-policy.js';
import { OperationLock, operationContext } from './operation-lock.js';

export interface ToolHandler {
  (args: Record<string, unknown>): Promise<CallToolResult>;
}

export type ToolResult = CallToolResult;

export interface ToolDefinition {
  tool: Tool;
  handler: ToolHandler;
}

export class ToolRegistry {
  private logger: Logger;
  private tools: Map<string, ToolDefinition>;

  private queue: Array<{
    run: () => Promise<ToolResult>;
    resolve: (result: ToolResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private active?: Promise<void>;
  private inCall = new AsyncLocalStorage<{ active: boolean }>();
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(
    private policy?: ToolPolicy,
    private operationLock = new OperationLock()
  ) {
    this.logger = new Logger('ToolRegistry');
    this.tools = new Map();
  }

  register(name: string, definition: ToolDefinition): void {
    if (disabledTools.has(name)) throw new Error('TOOL_DISABLED');
    if (this.policy) definition = this.policy.decorate(definition);
    if (this.tools.has(name)) {
      this.logger.warn(`Tool '${name}' already registered, overwriting`);
    }

    this.tools.set(name, definition);
    this.logger.debug(`Registered tool: ${name}`);
  }

  unregister(name: string): boolean {
    const result = this.tools.delete(name);
    if (result) {
      this.logger.debug(`Unregistered tool: ${name}`);
    }
    return result;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).map((def) => def.tool);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.stopped) throw new Error('SERVER_STOPPING');
    if (disabledTools.has(name)) throw new Error('TOOL_DISABLED');
    const definition = this.tools.get(name);
    if (!definition) throw new Error('TOOL_NOT_FOUND');
    if (!this.policy) throw new Error('POLICY_NOT_INITIALIZED');
    const policy = this.policy;
    const run = async () => {
      if (this.stopped) throw new Error('SERVER_STOPPING');
      if (name !== 'photoshop_get_capabilities' && this.operationLock.faulted)
        throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
      return await policy.run(definition, args);
    };
    if (this.inCall.getStore()?.active) return await run();
    return await new Promise<ToolResult>((resolve, reject) => {
      this.queue.push({
        resolve,
        reject,
        run: async () => {
          if (this.stopped) throw new Error('SERVER_STOPPING');
          const call = { active: true };
          const locked = name !== 'photoshop_get_capabilities';
          if (locked) await this.operationLock.acquire();
          try {
            return await this.inCall.run(call, async () => {
              const result = locked
                ? await operationContext.run(
                    {
                      lock: this.operationLock,
                      isStopping: () => this.stopped,
                    },
                    run
                  )
                : await run();
              if (locked && this.operationLock.faulted)
                throw new Error('SESSION_FAULTED_RESTART_REQUIRED');
              return result;
            });
          } finally {
            call.active = false;
            if (locked) await this.operationLock.release();
          }
        },
      });
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.active || this.stopped) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = Promise.resolve()
      .then(next.run)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.active = undefined;
        this.startNext();
      });
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopped = true;
      for (const queued of this.queue.splice(0)) queued.reject(new Error('SERVER_STOPPING'));
      this.stopping = this.active ?? Promise.resolve();
    }
    return this.stopping;
  }

  clear(): void {
    this.tools.clear();
    this.logger.debug('All tools cleared');
  }

  count(): number {
    return this.tools.size;
  }
}
