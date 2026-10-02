import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolPolicy, disabledTools } from '../security/tool-policy.js';

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

  private queue: Promise<unknown> = Promise.resolve();
  private inCall = new AsyncLocalStorage<boolean>();

  constructor(private policy?: ToolPolicy) {
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
    const run = async () => {
      if (disabledTools.has(name)) throw new Error('TOOL_DISABLED');
      const definition = this.tools.get(name);
      if (!definition) throw new Error('TOOL_NOT_FOUND');
      if (!this.policy) throw new Error('POLICY_NOT_INITIALIZED');
      return await this.policy.run(definition, args);
    };
    if (this.inCall.getStore()) return await run();
    const result = this.queue.then(() => this.inCall.run(true, run));
    this.queue = result.catch(() => undefined);
    return await result;
  }

  clear(): void {
    this.tools.clear();
    this.logger.debug('All tools cleared');
  }

  count(): number {
    return this.tools.size;
  }
}
