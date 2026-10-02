import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { Logger } from '../utils/logger.js';
import { ToolRegistry } from './tool-registry.js';
import { Session } from './session.js';
import { createDocumentTools } from '../tools/document-tools.js';
import { createLayerTools } from '../tools/layer-tools.js';
import { createImageTools } from '../tools/image-tools.js';
import { createImagePlacementTools } from '../tools/image-placement-tools.js';
import { createLayerTransformTools } from '../tools/layer-transform-tools.js';
import { createLayerPropertiesTools } from '../tools/layer-properties-tools.js';
import { createFilterTools } from '../tools/filter-tools.js';
import { createAdjustmentTools } from '../tools/adjustment-tools.js';
import { createTextTools } from '../tools/text-tools.js';
import { createSelectionTools } from '../tools/selection-tools.js';
import { createLayerOrderingTools } from '../tools/layer-ordering-tools.js';
import { createAdvancedTools } from '../tools/advanced-tools.js';

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectPolicy } from '../security/project-policy.js';
import { ToolPolicy } from '../security/tool-policy.js';

export class PhotoshopMCPServer {
  private server: Server;
  private logger = new Logger('PhotoshopMCPServer');
  private session = new Session({ autoConnect: false });
  private toolRegistry?: ToolRegistry;
  private writerLock = join(tmpdir(), 'photoshop-mcp-single-writer');
  private ownsLock = false;
  private stopping?: Promise<void>;

  constructor() {
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: { tools: {}, resources: {}, prompts: {} },
      }
    );
  }

  private registerTools(projects: ProjectPolicy): void {
    const connection = this.session.getConnection();
    const registry = new ToolRegistry(new ToolPolicy(projects, connection));
    this.toolRegistry = registry;
    for (const name of ['photoshop_ping', 'photoshop_get_version']) {
      registry.register(name, {
        tool: {
          name,
          description:
            'Read application version only. Does not launch Photoshop or inspect documents.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => {
          const info = await connection.getVersionInfo();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  name: info.name,
                  version: info.version,
                  isRunning: info.isRunning,
                  canExecuteScript: info.canExecuteScript,
                }),
              },
            ],
          };
        },
      });
    }
    registry.register('photoshop_get_capabilities', {
      tool: {
        name: 'photoshop_get_capabilities',
        description: 'Inspect this runtime and registered project IDs without starting Photoshop.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              projects: projects.list(),
              tools: registry.list().map((t) => t.name),
              imageDelivery: 'local-only',
              uiCapture: false,
              rawScripts: false,
              historyRecovery: 'disabled-unverified',
              autoLaunch: false,
            }),
          },
        ],
      }),
    });
    const groups = [
      createDocumentTools(connection),
      createLayerTools(connection),
      createImageTools(connection),
      createImagePlacementTools(connection),
      createLayerTransformTools(connection),
      createLayerPropertiesTools(connection),
      createFilterTools(connection),
      createAdjustmentTools(connection),
      createTextTools(connection),
      createSelectionTools(connection),
      createLayerOrderingTools(connection),
      createAdvancedTools(connection, (name, args) => registry.execute(name, args)),
    ];
    for (const tools of groups) for (const tool of tools) registry.register(tool.tool.name, tool);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolRegistry!.list(),
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.toolRegistry!.execute(
          request.params.name,
          request.params.arguments ?? {}
        );
      } catch (error) {
        // Do not echo input, paths, document titles, script source or stack traces.
        const message = error instanceof Error ? error.message : '';
        const safe = /^[A-Z_]+(?:: [a-zA-Z0-9_.]+)?$/.test(message)
          ? message
          : 'OPERATION_DENIED_OR_FAILED';
        return { isError: true, content: [{ type: 'text', text: safe }] };
      }
    });
    // Legacy resources/prompts had no project or document scope. No implicit active-document reads.
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    this.server.setRequestHandler(ReadResourceRequestSchema, async () => {
      throw new Error('Use project-scoped tools');
    });
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
    this.server.setRequestHandler(GetPromptRequestSchema, async () => {
      throw new Error('Use project-scoped tools');
    });
  }

  async start(): Promise<void> {
    this.registerTools(await ProjectPolicy.load());
    this.setupHandlers();
    // Fail closed on stale locks. Never kill another process or automatically take over.
    await mkdir(this.writerLock, { mode: 0o700 });
    this.ownsLock = true;
    process.once('exit', () => {
      if (this.ownsLock) rmSync(this.writerLock, { recursive: true, force: true });
    });
    process.stdin.once('end', () => {
      void this.stop();
    });
    try {
      await writeFile(join(this.writerLock, 'pid'), String(process.pid), {
        flag: 'wx',
        mode: 0o600,
      });
      this.server.onclose = () => {
        void this.stop();
      };
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void this.stop().finally(() => process.exit(0));
        });
      await this.server.connect(new StdioServerTransport());
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.logger.info('Project-scoped MCP connected via stdio; Photoshop has not been launched.');
  }
  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = Promise.resolve().then(async () => {
        try {
          await this.server.close();
        } finally {
          if (this.ownsLock) {
            this.ownsLock = false;
            await rm(this.writerLock, { recursive: true, force: true });
          }
        }
      });
    }
    return await this.stopping;
  }
}
