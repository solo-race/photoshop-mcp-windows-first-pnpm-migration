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
import { categorizeError } from './error-taxonomy.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { createEnvelope, createToolResult, buildExecutionInfo } from './result.js';
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
import { createActionTools } from '../tools/action-tools.js';
import { createHistoryTools } from '../tools/history-tools.js';
import { createLayerOrderingTools } from '../tools/layer-ordering-tools.js';
import { createAdvancedTools } from '../tools/advanced-tools.js';
import { PhotoshopResourceProvider } from '../resources/photoshop-resources.js';
import { PhotoshopPromptProvider } from '../prompts/photoshop-prompts.js';

export class PhotoshopMCPServer {
  private server: Server;
  private logger: Logger;
  private toolRegistry: ToolRegistry;
  private session: Session;
  private resourceProvider: PhotoshopResourceProvider;
  private promptProvider: PhotoshopPromptProvider;

  constructor() {
    this.logger = new Logger('PhotoshopMCPServer');
    this.toolRegistry = new ToolRegistry();
    this.session = new Session();
    const connection = this.session.getConnection();
    this.resourceProvider = new PhotoshopResourceProvider(connection, this.session);
    this.promptProvider = new PhotoshopPromptProvider(connection, this.session);

    this.server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.registerTools();
    this.setupHandlers();
  }

  private registerTools() {
    // Register basic tools
    this.toolRegistry.register('photoshop_ping', {
      tool: {
        name: 'photoshop_ping',
        description: 'Test connection to Photoshop',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => await this.pingPhotoshop(),
    });

    this.toolRegistry.register('photoshop_get_version', {
      tool: {
        name: 'photoshop_get_version',
        description: 'Get Photoshop version information',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => await this.getVersion(),
    });

    const connection = this.session.getConnection();
    
    const documentTools = createDocumentTools(connection);
    documentTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const layerTools = createLayerTools(connection);
    layerTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const imageTools = createImageTools(connection);
    imageTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const imagePlacementTools = createImagePlacementTools(connection);
    imagePlacementTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const layerTransformTools = createLayerTransformTools(connection);
    layerTransformTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const layerPropertiesTools = createLayerPropertiesTools(connection);
    layerPropertiesTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const filterTools = createFilterTools(connection);
    filterTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const adjustmentTools = createAdjustmentTools(connection);
    adjustmentTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const textTools = createTextTools(connection);
    textTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const selectionTools = createSelectionTools(connection);
    selectionTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const actionTools = createActionTools(connection);
    actionTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const historyTools = createHistoryTools(connection);
    historyTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const layerOrderingTools = createLayerOrderingTools(connection);
    layerOrderingTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    const advancedTools = createAdvancedTools(
      connection,
      this.session,
      async (name, args) => await this.toolRegistry.execute(name, args)
    );
    advancedTools.forEach((tool) => {
      this.toolRegistry.register(tool.tool.name, tool);
    });

    this.logger.info(`Registered ${this.toolRegistry.count()} tools`);
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Listing available tools');
      return {
        tools: this.toolRegistry.list(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logger.debug(`Tool called: ${request.params.name}`);
      
      try {
        const args = (request.params.arguments as Record<string, unknown>) || {};
        const result = await this.toolRegistry.execute(request.params.name, args);
        
        // Update session activity
        this.session.updateActivity();

        if (result.isError) {
          this.session.recordError(
            categorizeError(
              result.content
                .filter((block) => block.type === 'text')
                .map((block) => ('text' in block ? block.text : ''))
                .join('\n'),
              request.params.name
            )
          );
        }
        
        return result;
      } catch (error) {
        this.logger.error(`Tool execution failed: ${request.params.name}`, error);
        const record = categorizeError(error, request.params.name);
        this.session.recordError(record);
        return createToolResult(
          createEnvelope({
            ok: false,
            summary: `Tool execution failed: ${record.message}`,
            data: {
              error: record,
            },
            warnings: [],
            context: {},
            execution: buildExecutionInfo('auto', 'workflow', 0, false),
            nextSuggestedActions: record.suggestedActions,
          })
        );
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return await this.resourceProvider.list();
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await this.resourceProvider.read(request.params.uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return await this.promptProvider.list();
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await this.promptProvider.get(
        request.params.name,
        request.params.arguments as Record<string, string> | undefined
      );
    });
  }

  private async pingPhotoshop() {
    const connection = this.session.getConnection();
    const startedAt = Date.now();

    try {
      const info = await connection.getVersionInfo();
      const envelope = createEnvelope({
        ok: info.canExecuteScript,
        summary: info.canExecuteScript
          ? `Photoshop responded to a smoke script as ${info.name} ${info.version}.`
          : `Photoshop was detected at ${info.detectedPath}, but script execution is not ready.`,
        data: info,
        warnings: info.canExecuteScript ? [] : ['Photoshop detection succeeded, but the smoke script did not complete.'],
        context: {},
        execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, false),
        nextSuggestedActions: info.canExecuteScript
          ? ['Use photoshop_get_state to inspect the current workspace.']
          : ['Launch Photoshop manually and retry, or inspect configuration with photoshop_get_version.'],
      });
      this.session.recordToolResult('photoshop_ping', envelope);
      return createToolResult(envelope);
    } catch (error) {
      const record = categorizeError(error, 'photoshop_ping');
      this.session.recordError(record);
      return createToolResult(
        createEnvelope({
          ok: false,
          summary: `photoshop_ping failed: ${record.message}`,
          data: { error: record },
          warnings: [],
          context: {},
          execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, false),
          nextSuggestedActions: record.suggestedActions,
        })
      );
    }
  }

  private async getVersion() {
    const connection = this.session.getConnection();
    const startedAt = Date.now();

    try {
      const info = await connection.getVersionInfo();
      const envelope = createEnvelope({
        ok: true,
        summary: `Detected ${info.name} ${info.version} at ${info.detectedPath}.`,
        data: info,
        warnings: info.canExecuteScript ? [] : ['Script execution could not be confirmed yet.'],
        context: {},
        execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, false),
        nextSuggestedActions: ['Use photoshop_ping for a smoke test or photoshop_get_state for workspace context.'],
      });
      this.session.recordToolResult('photoshop_get_version', envelope);
      return createToolResult(envelope);
    } catch (error) {
      const record = categorizeError(error, 'photoshop_get_version');
      this.session.recordError(record);
      return createToolResult(
        createEnvelope({
          ok: false,
          summary: `photoshop_get_version failed: ${record.message}`,
          data: { error: record },
          warnings: [],
          context: {},
          execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, false),
          nextSuggestedActions: record.suggestedActions,
        })
      );
    }
  }

  async start() {
    // Initialize session
    await this.session.initialize();

    // Connect server transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    this.logger.info('MCP Server connected via stdio');
  }

  async stop() {
    await this.session.disconnect();
    this.logger.info('MCP Server stopped');
  }
}
