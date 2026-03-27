import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { categorizeError, shouldUseUiFallback } from '../core/error-taxonomy.js';
import type {
  CheckpointRecord,
  ExecutionMode,
  ExecutionStrategy,
  SequenceStep,
} from '../core/models.js';
import {
  TOOL_ENVELOPE_OUTPUT_SCHEMA,
  buildExecutionInfo,
  createEnvelope,
  createToolResult,
  formatEnvelopeText,
  responseDetailFromArgs,
} from '../core/result.js';
import { toPlainObject } from '../core/serializer.js';
import { Session } from '../core/session.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { WindowsUIController, toSendKeys } from '../platform/windows-ui.js';
import { PhotoshopStateService } from '../state/state-service.js';
import { normalizeDocumentRef, normalizeLayerRef } from '../targets/ref-resolver.js';
import type { ToolDefinition } from '../core/tool-registry.js';

const responseDetailSchema = {
  type: 'string',
  enum: ['minimal', 'normal', 'full'],
  default: 'normal',
  description: 'How much structured state to include in the response.',
} as const;

const executionModeSchema = {
  type: 'string',
  enum: ['script', 'ui', 'auto'],
  default: 'auto',
  description: 'Preferred execution path. "auto" tries script first and falls back to UI when appropriate.',
} as const;

const documentRefSchema = {
  type: 'object',
  description: 'Document selector. Index is 1-based.',
  properties: {
    by: { type: 'string', enum: ['active', 'id', 'name', 'index'] },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
  additionalProperties: false,
} as const;

const layerRefSchema = {
  type: 'object',
  description: 'Layer selector. Index is 1-based. Path uses slash-separated group/layer names.',
  properties: {
    by: { type: 'string', enum: ['active', 'id', 'name', 'index', 'path'] },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
  additionalProperties: false,
} as const;

type ExecuteTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

interface OperationOptions<TData> {
  toolName: string;
  mode: ExecutionMode;
  scriptAction?: () => Promise<TData>;
  uiAction?: () => Promise<TData>;
  summary: (data: TData, fallbackUsed: boolean) => string;
  nextSuggestedActions?: string[];
  warnings?: string[];
  context?: Record<string, unknown> | (() => Promise<Record<string, unknown>>);
}

function extractText(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n')
    .trim();
}

function toolDefinition(
  name: string,
  description: string,
  inputSchema: Tool['inputSchema'],
  handler: ToolDefinition['handler'],
  readOnly: boolean
): ToolDefinition {
  return {
    tool: {
      name,
      description,
      inputSchema,
      outputSchema: TOOL_ENVELOPE_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    },
    handler,
  };
}

export function createAdvancedTools(
  connection: PhotoshopConnection,
  session: Session,
  executeTool: ExecuteTool
): ToolDefinition[] {
  const state = new PhotoshopStateService(connection, session);
  const windowsUi = new WindowsUIController();

  async function safeContext(): Promise<Record<string, unknown>> {
    try {
      return await state.getActiveContext('minimal');
    } catch {
      return {};
    }
  }

  async function resolveContext(
    context: OperationOptions<unknown>['context']
  ): Promise<Record<string, unknown>> {
    if (!context) {
      return await safeContext();
    }

    if (typeof context === 'function') {
      return await context();
    }

    return context;
  }

  async function runOperation<TData>(options: OperationOptions<TData>): Promise<CallToolResult> {
    const startedAt = Date.now();
    let strategy: ExecutionStrategy = options.mode === 'ui' ? 'ui' : 'script';
    let fallbackUsed = false;
    const warnings = [...(options.warnings ?? [])];

    try {
      let data: TData;

      if (options.mode === 'ui') {
        if (!options.uiAction) {
          throw new Error('UI execution is not available for this tool.');
        }
        data = await options.uiAction();
        strategy = 'ui';
      } else if (options.mode === 'script') {
        if (!options.scriptAction) {
          throw new Error('Script execution is not available for this tool.');
        }
        data = await options.scriptAction();
        strategy = 'script';
      } else {
        try {
          if (!options.scriptAction) {
            throw new Error('Script execution is not available for this tool.');
          }
          data = await options.scriptAction();
          strategy = 'script';
        } catch (error) {
          if (options.uiAction && shouldUseUiFallback(error)) {
            data = await options.uiAction();
            strategy = 'ui';
            fallbackUsed = true;
            warnings.push(`Script strategy failed and UI fallback was used: ${String(error)}`);
          } else {
            throw error;
          }
        }
      }

      const envelope = createEnvelope({
        ok: true,
        summary: options.summary(data, fallbackUsed),
        data: toPlainObject(data),
        warnings,
        context: await resolveContext(options.context),
        execution: buildExecutionInfo(
          options.mode,
          strategy,
          Date.now() - startedAt,
          fallbackUsed
        ),
        nextSuggestedActions: options.nextSuggestedActions,
      });

      session.clearLastError();
      session.recordToolResult(options.toolName, envelope);
      return createToolResult(envelope);
    } catch (error) {
      const record = categorizeError(error, options.toolName);
      session.recordError(record);
      const envelope = createEnvelope({
        ok: false,
        summary: `${options.toolName} failed: ${record.message}`,
        data: { error: record },
        warnings,
        context: await safeContext(),
        execution: buildExecutionInfo(
          options.mode,
          strategy,
          Date.now() - startedAt,
          fallbackUsed
        ),
        nextSuggestedActions: record.suggestedActions,
      });

      session.recordToolResult(options.toolName, envelope);
      return createToolResult(envelope);
    }
  }

  async function runSequenceInternal(
    steps: SequenceStep[],
    stopOnError: boolean
  ): Promise<{ success: boolean; steps: Record<string, unknown>[] }> {
    const results: Record<string, unknown>[] = [];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step.tool === 'photoshop_run_sequence' || step.tool === 'photoshop_run_transaction') {
        throw new Error(`Nested workflow recursion is not supported for ${step.tool}`);
      }

      const result = await executeTool(step.tool, step.args ?? {});
      results.push({
        index: index + 1,
        tool: step.tool,
        isError: Boolean(result.isError),
        text: extractText(result),
        structured: toPlainObject(result.structuredContent),
      });

      if (result.isError && (step.stopOnError ?? stopOnError)) {
        return { success: false, steps: results };
      }
    }

    return { success: true, steps: results };
  }

  async function latestCheckpoint(): Promise<CheckpointRecord | null> {
    const checkpoints = session.listCheckpoints();
    return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
  }

  return [
    toolDefinition(
      'photoshop_get_state',
      'Return the current Photoshop application, document, layer, history, and optional deep state snapshot.',
      {
        type: 'object',
        properties: { responseDetail: responseDetailSchema },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_state',
          mode: 'script',
          scriptAction: async () =>
            await state.getState(responseDetailFromArgs(args.responseDetail)),
          summary: (data) =>
            `Fetched Photoshop state (${responseDetailFromArgs(args.responseDetail)} detail) with ${Number((toPlainObject(data).documents as unknown[] | undefined)?.length || 0)} open document(s).`,
          nextSuggestedActions: ['Use photoshop_get_layer_tree or photoshop_get_ui_snapshot for deeper inspection.'],
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_open_documents',
      'List open Photoshop documents with optional detail.',
      {
        type: 'object',
        properties: { responseDetail: responseDetailSchema },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_open_documents',
          mode: 'script',
          scriptAction: async () =>
            await state.getOpenDocuments(responseDetailFromArgs(args.responseDetail)),
          summary: (data) => `Found ${Number(data.total || 0)} open Photoshop document(s).`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_document_tree',
      'Return open documents with nested layer trees for agent-side targeting.',
      {
        type: 'object',
        properties: { responseDetail: responseDetailSchema },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_document_tree',
          mode: 'script',
          scriptAction: async () =>
            await state.getDocumentTree(responseDetailFromArgs(args.responseDetail, 'full')),
          summary: (data) => `Built a document tree for ${Number(data.total || 0)} document(s).`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_active_context',
      'Return a compact state snapshot focused on the active document, active layer, and history.',
      {
        type: 'object',
        properties: { responseDetail: responseDetailSchema },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_active_context',
          mode: 'script',
          scriptAction: async () =>
            await state.getActiveContext(responseDetailFromArgs(args.responseDetail)),
          summary: (data) =>
            data.hasDocument
              ? `Active document: ${String(toPlainObject(data.activeDocument).name || 'Unknown')}.`
              : 'Photoshop has no active document.',
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_layer_tree',
      'Return a layer tree for the selected document target.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          responseDetail: responseDetailSchema,
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_layer_tree',
          mode: 'script',
          scriptAction: async () =>
            await state.getLayerTree(
              normalizeDocumentRef(args.documentRef),
              responseDetailFromArgs(args.responseDetail, 'full')
            ),
          summary: (data) => `Resolved ${Number(data.total || 0)} top-level layer entries.`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_layer_info',
      'Resolve a layer target and return structured metadata for it.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          layerRef: layerRefSchema,
          responseDetail: responseDetailSchema,
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_layer_info',
          mode: 'script',
          scriptAction: async () =>
            await state.getLayerInfo(
              normalizeDocumentRef(args.documentRef),
              normalizeLayerRef(args.layerRef),
              responseDetailFromArgs(args.responseDetail)
            ),
          summary: (data) => {
            const layer = toPlainObject(data.layer);
            return `Resolved layer "${String(layer.name || 'Unknown')}".`;
          },
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_selection_bounds',
      'Return the current selection bounds for a document if a selection exists.',
      {
        type: 'object',
        properties: { documentRef: documentRefSchema },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_selection_bounds',
          mode: 'script',
          scriptAction: async () =>
            await state.getSelectionBounds(normalizeDocumentRef(args.documentRef)),
          summary: (data) =>
            toPlainObject(data).selectionBounds
              ? 'Resolved selection bounds.'
              : 'No active selection was found.',
        }),
      true
    ),
    toolDefinition(
      'photoshop_get_last_error',
      'Return the most recent structured Photoshop MCP error recorded in this session.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () => {
        const startedAt = Date.now();
        const lastError = session.getLastError();
        const envelope = createEnvelope({
          ok: true,
          summary: lastError ? `Last error: ${lastError.message}` : 'No session error is currently recorded.',
          data: { lastError },
          warnings: [],
          context: await safeContext(),
          execution: buildExecutionInfo('script', 'resource', Date.now() - startedAt, false),
          nextSuggestedActions: lastError ? lastError.suggestedActions : [],
        });

        session.recordToolResult('photoshop_get_last_error', envelope);
        return createToolResult(envelope);
      },
      true
    ),
    toolDefinition(
      'photoshop_select_document',
      'Resolve a document target and make it the active document.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          executionMode: executionModeSchema,
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_select_document',
          mode: (args.executionMode as ExecutionMode) || 'script',
          scriptAction: async () => await state.selectDocument(normalizeDocumentRef(args.documentRef)),
          summary: (data) =>
            `Selected document "${String(toPlainObject(data.document).name || 'Unknown')}".`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_select_layer',
      'Resolve a layer target and make it the active layer.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          layerRef: layerRefSchema,
          executionMode: executionModeSchema,
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_select_layer',
          mode: (args.executionMode as ExecutionMode) || 'script',
          scriptAction: async () =>
            await state.selectLayer(
              normalizeDocumentRef(args.documentRef),
              normalizeLayerRef(args.layerRef)
            ),
          summary: (data) => `Selected layer "${String(toPlainObject(data.layer).name || 'Unknown')}".`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_find_layers',
      'Search layers by name or slash path across the selected document.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          query: {
            type: 'string',
            description: 'Layer name or slash path fragment to match.',
          },
          matchMode: {
            type: 'string',
            enum: ['contains', 'exact'],
            default: 'contains',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_find_layers',
          mode: 'script',
          scriptAction: async () =>
            await state.findLayers(
              normalizeDocumentRef(args.documentRef),
              String(args.query),
              (args.matchMode as 'contains' | 'exact') || 'contains'
            ),
          summary: (data) => `Found ${Number(data.total || 0)} matching layer(s).`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_find_text_layers',
      'Search only text layers by name or path.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          query: { type: 'string' },
          matchMode: {
            type: 'string',
            enum: ['contains', 'exact'],
            default: 'contains',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_find_text_layers',
          mode: 'script',
          scriptAction: async () =>
            await state.findLayers(
              normalizeDocumentRef(args.documentRef),
              String(args.query),
              (args.matchMode as 'contains' | 'exact') || 'contains',
              true
            ),
          summary: (data) => `Found ${Number(data.total || 0)} matching text layer(s).`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_select_history_state',
      'Select a Photoshop history state by 1-based index or exact state name.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          state: {
            anyOf: [{ type: 'string' }, { type: 'number' }],
            description: 'History state name or 1-based index.',
          },
        },
        required: ['state'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_select_history_state',
          mode: 'script',
          scriptAction: async () =>
            await state.selectHistoryState(
              normalizeDocumentRef(args.documentRef),
              args.state as string | number
            ),
          summary: (data) =>
            `Selected history state "${String(toPlainObject(toPlainObject(data.history)).currentStateName || 'Unknown')}".`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_duplicate_document',
      'Duplicate a target document and optionally rename the duplicate.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          newName: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_duplicate_document',
          mode: 'script',
          scriptAction: async () =>
            await state.duplicateDocument(
              normalizeDocumentRef(args.documentRef),
              typeof args.newName === 'string' ? args.newName : undefined
            ),
          summary: (data) =>
            `Duplicated document as "${String(toPlainObject(data.duplicateDocument).name || 'Unknown')}".`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_save_copy',
      'Save a copy of the selected document to a specific path and format.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          path: { type: 'string' },
          format: {
            type: 'string',
            enum: ['PSD', 'JPEG', 'PNG'],
            default: 'PSD',
          },
          quality: {
            type: 'number',
            minimum: 1,
            maximum: 12,
            default: 8,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_save_copy',
          mode: 'script',
          scriptAction: async () =>
            await state.saveCopy(
              normalizeDocumentRef(args.documentRef),
              String(args.path),
              ((args.format as 'PSD' | 'JPEG' | 'PNG') || 'PSD'),
              Number(args.quality || 8)
            ),
          summary: (data) => `Saved a copy to ${String(data.outputPath || 'the requested path')}.`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_export_document',
      'Export the selected document to PSD, JPEG, or PNG using the structured save-copy path.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          path: { type: 'string' },
          format: {
            type: 'string',
            enum: ['PSD', 'JPEG', 'PNG'],
            default: 'PNG',
          },
          quality: {
            type: 'number',
            minimum: 1,
            maximum: 12,
            default: 8,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_export_document',
          mode: 'script',
          scriptAction: async () =>
            await state.saveCopy(
              normalizeDocumentRef(args.documentRef),
              String(args.path),
              ((args.format as 'PSD' | 'JPEG' | 'PNG') || 'PNG'),
              Number(args.quality || 8)
            ),
          summary: (data) => `Exported document to ${String(data.outputPath || 'the requested path')}.`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_resize_canvas',
      'Resize the selected document canvas while keeping content centered.',
      {
        type: 'object',
        properties: {
          documentRef: documentRefSchema,
          width: { type: 'number', minimum: 1 },
          height: { type: 'number', minimum: 1 },
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_resize_canvas',
          mode: 'script',
          scriptAction: async () =>
            await state.resizeCanvas(
              normalizeDocumentRef(args.documentRef),
              Number(args.width),
              Number(args.height)
            ),
          summary: (data) =>
            `Canvas resized to ${String(toPlainObject(data.document).width || '?')}x${String(
              toPlainObject(data.document).height || '?'
            )} px.`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_execute_script_with_state',
      'Execute arbitrary ExtendScript directly, then append a structured Photoshop state snapshot for continued agent reasoning.',
      {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Raw ExtendScript to run. This is an escape hatch and is not guaranteed to be stable.',
          },
          responseDetail: responseDetailSchema,
        },
        required: ['code'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_execute_script_with_state',
          mode: 'script',
          scriptAction: async () =>
            await state.executeRawScriptWithState(
              String(args.code),
              responseDetailFromArgs(args.responseDetail)
            ),
          summary: () => 'Executed raw ExtendScript and captured follow-up Photoshop state.',
          warnings: [
            'This tool is an escape hatch. Raw script output is not guaranteed to be structured or stable.',
          ],
          nextSuggestedActions: [
            'Use photoshop_get_state or photoshop_get_layer_tree to continue with structured reasoning.',
          ],
        }),
      false
    ),
    toolDefinition(
      'photoshop_run_sequence',
      'Run multiple MCP Photoshop tools in order and aggregate the results.',
      {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                args: { type: 'object', additionalProperties: true },
                stopOnError: { type: 'boolean' },
              },
              required: ['tool'],
              additionalProperties: false,
            },
          },
          stopOnError: { type: 'boolean', default: true },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      async (args) => {
        const startedAt = Date.now();
        try {
          const steps = Array.isArray(args.steps) ? (args.steps as SequenceStep[]) : [];
          const outcome = await runSequenceInternal(steps, args.stopOnError !== false);
          const envelope = createEnvelope({
            ok: outcome.success,
            summary: outcome.success
              ? `Completed ${outcome.steps.length} workflow step(s).`
              : `Sequence stopped after ${outcome.steps.length} step(s) because a step failed.`,
            data: outcome,
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo(
              'script',
              'workflow',
              Date.now() - startedAt,
              false
            ),
            nextSuggestedActions: outcome.success
              ? ['Use photoshop_get_state to inspect the final state if needed.']
              : ['Review the failing step output and retry the sequence from that point.'],
          });

          session.recordToolResult('photoshop_run_sequence', envelope);
          return createToolResult(envelope);
        } catch (error) {
          const record = categorizeError(error, 'photoshop_run_sequence');
          session.recordError(record);
          const envelope = createEnvelope({
            ok: false,
            summary: `photoshop_run_sequence failed: ${record.message}`,
            data: { error: record },
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo(
              'script',
              'workflow',
              Date.now() - startedAt,
              false
            ),
            nextSuggestedActions: record.suggestedActions,
          });
          session.recordToolResult('photoshop_run_sequence', envelope);
          return createToolResult(envelope);
        }
      },
      false
    ),
    toolDefinition(
      'photoshop_run_transaction',
      'Create a checkpoint, run a sequence, and optionally roll back to the checkpoint on failure.',
      {
        type: 'object',
        properties: {
          checkpointName: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                args: { type: 'object', additionalProperties: true },
                stopOnError: { type: 'boolean' },
              },
              required: ['tool'],
              additionalProperties: false,
            },
          },
          rollbackOnError: { type: 'boolean', default: true },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      async (args) => {
        const startedAt = Date.now();
        const checkpointName =
          typeof args.checkpointName === 'string'
            ? args.checkpointName
            : `transaction-${Date.now()}`;

        try {
          const checkpoint = await state.createCheckpoint(checkpointName);
          const steps = Array.isArray(args.steps) ? (args.steps as SequenceStep[]) : [];
          const outcome = await runSequenceInternal(steps, true);
          let rollbackResult: Record<string, unknown> | null = null;

          if (!outcome.success && args.rollbackOnError !== false) {
            rollbackResult = await state.restoreCheckpoint(checkpoint.name);
          }

          const envelope = createEnvelope({
            ok: outcome.success,
            summary: outcome.success
              ? `Transaction completed successfully with checkpoint "${checkpoint.name}".`
              : `Transaction failed and ${rollbackResult ? 'rolled back' : 'did not roll back'} to "${checkpoint.name}".`,
            data: { checkpoint, outcome, rollbackResult },
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo(
              'script',
              'workflow',
              Date.now() - startedAt,
              false
            ),
            nextSuggestedActions: outcome.success
              ? ['Use photoshop_snapshot_checkpoint if you want to preserve this new state explicitly.']
              : ['Inspect the failing step output before retrying the transaction.'],
          });

          session.recordToolResult('photoshop_run_transaction', envelope);
          return createToolResult(envelope);
        } catch (error) {
          const record = categorizeError(error, 'photoshop_run_transaction');
          session.recordError(record);
          const envelope = createEnvelope({
            ok: false,
            summary: `photoshop_run_transaction failed: ${record.message}`,
            data: { error: record },
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo(
              'script',
              'workflow',
              Date.now() - startedAt,
              false
            ),
            nextSuggestedActions: record.suggestedActions,
          });
          session.recordToolResult('photoshop_run_transaction', envelope);
          return createToolResult(envelope);
        }
      },
      false
    ),
    toolDefinition(
      'photoshop_assert_state',
      'Assert a few high-signal Photoshop state conditions before or after an edit.',
      {
        type: 'object',
        properties: {
          responseDetail: responseDetailSchema,
          requiresDocument: { type: 'boolean' },
          documentNameContains: { type: 'string' },
          activeLayerName: { type: 'string' },
          minimumLayerCount: { type: 'number', minimum: 0 },
          hasSelection: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_assert_state',
          mode: 'script',
          scriptAction: async () => await state.assertState(args),
          summary: (data) =>
            data.passed
              ? 'State assertions passed.'
              : `State assertions failed: ${Array.isArray(data.failures) ? data.failures.join(' | ') : 'Unknown failure'}`,
          nextSuggestedActions: ['Use photoshop_get_state or photoshop_get_active_context to inspect the mismatch.'],
        }),
      true
    ),
    toolDefinition(
      'photoshop_snapshot_checkpoint',
      'Create an in-memory checkpoint using the active history state and a structured snapshot.',
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          documentRef: documentRefSchema,
        },
        required: ['name'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_snapshot_checkpoint',
          mode: 'script',
          scriptAction: async () =>
            await state.createCheckpoint(String(args.name), normalizeDocumentRef(args.documentRef)),
          summary: (data) => `Created checkpoint "${String(data.name || 'Unnamed')}".`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_restore_checkpoint',
      'Restore a previously saved in-memory checkpoint when it includes a usable history state.',
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_restore_checkpoint',
          mode: 'script',
          scriptAction: async () => await state.restoreCheckpoint(String(args.name)),
          summary: () => `Restored checkpoint "${String(args.name)}".`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_wait_for_idle',
      'Poll Photoshop until a lightweight state call succeeds or the timeout is hit.',
      {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number', minimum: 100, default: 5000 },
          intervalMs: { type: 'number', minimum: 50, default: 300 },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_wait_for_idle',
          mode: 'script',
          scriptAction: async () =>
            await state.waitForIdle(Number(args.timeoutMs || 5000), Number(args.intervalMs || 300)),
          summary: (data) => `Photoshop responded after ${Number(data.waitedMs || 0)}ms.`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_recover_last_error',
      'Attempt a best-effort recovery using the last recorded error and the newest checkpoint.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () => {
        const startedAt = Date.now();
        const lastError = session.getLastError();

        if (!lastError) {
          const envelope = createEnvelope({
            ok: true,
            summary: 'No recorded error is available to recover from.',
            data: {},
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo('auto', 'workflow', Date.now() - startedAt, false),
            nextSuggestedActions: [],
          });
          session.recordToolResult('photoshop_recover_last_error', envelope);
          return createToolResult(envelope);
        }

        try {
          let recovery: Record<string, unknown> = { strategy: 'none', lastError };

          if (lastError.category === 'dialog-blocked' || lastError.category === 'ui-required') {
            await windowsUi.focusWindow();
            const shortcutResult = await windowsUi.sendShortcut(
              toSendKeys('escape'),
              'escape'
            );
            recovery = {
              strategy: 'ui-dismiss-dialog',
              lastError,
              shortcutResult,
            };
          } else {
            const checkpoint = await latestCheckpoint();
            if (checkpoint) {
              const restoreResult = await state.restoreCheckpoint(checkpoint.name);
              recovery = {
                strategy: 'restore-checkpoint',
                lastError,
                checkpoint,
                restoreResult,
              };
            }
          }

          const envelope = createEnvelope({
            ok: true,
            summary: `Recovery attempted using ${String(recovery.strategy)}.`,
            data: recovery,
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo('auto', 'workflow', Date.now() - startedAt, false),
            nextSuggestedActions: ['Re-run the failed action or inspect state with photoshop_get_state.'],
          });
          session.recordToolResult('photoshop_recover_last_error', envelope);
          return createToolResult(envelope);
        } catch (error) {
          const record = categorizeError(error, 'photoshop_recover_last_error');
          session.recordError(record);
          const envelope = createEnvelope({
            ok: false,
            summary: `photoshop_recover_last_error failed: ${record.message}`,
            data: { error: record, lastError },
            warnings: [],
            context: await safeContext(),
            execution: buildExecutionInfo('auto', 'workflow', Date.now() - startedAt, false),
            nextSuggestedActions: record.suggestedActions,
          });
          session.recordToolResult('photoshop_recover_last_error', envelope);
          return createToolResult(envelope);
        }
      },
      false
    ),
    toolDefinition(
      'photoshop_get_ui_snapshot',
      'Return the current Photoshop top-level windows and a limited UI Automation control snapshot.',
      {
        type: 'object',
        properties: {
          titleContains: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_get_ui_snapshot',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.getUiSnapshot(
              typeof args.titleContains === 'string' ? args.titleContains : undefined
            ),
          summary: () => 'Captured Photoshop UI snapshot.',
        }),
      true
    ),
    toolDefinition(
      'photoshop_ui_list_windows',
      'List Photoshop top-level windows visible to Windows UI Automation.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () =>
        await runOperation({
          toolName: 'photoshop_ui_list_windows',
          mode: 'ui',
          uiAction: async () => await windowsUi.listWindows(),
          summary: (data) => `Found ${Number(data.total || 0)} Photoshop window(s).`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_ui_list_controls',
      'List a bounded set of UI Automation descendants for the Photoshop window.',
      {
        type: 'object',
        properties: {
          titleContains: { type: 'string' },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 250,
            default: 80,
          },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_ui_list_controls',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.listControls(
              typeof args.titleContains === 'string' ? args.titleContains : undefined,
              Number(args.limit || 80)
            ),
          summary: (data) => `Listed ${Number(data.total || 0)} UI control(s).`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_send_shortcut',
      'Focus Photoshop and send a Windows SendKeys-compatible shortcut sequence.',
      {
        type: 'object',
        properties: {
          shortcut: {
            type: 'string',
            description: 'Shortcut like ctrl+shift+z, escape, tab, or f7.',
          },
          titleContains: { type: 'string' },
        },
        required: ['shortcut'],
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_send_shortcut',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.sendShortcut(
              toSendKeys(String(args.shortcut)),
              String(args.shortcut),
              typeof args.titleContains === 'string' ? args.titleContains : undefined
            ),
          summary: () => `Sent shortcut "${String(args.shortcut)}" to Photoshop.`,
        }),
      false
    ),
    toolDefinition(
      'photoshop_ui_wait_for_dialog',
      'Wait for a Photoshop dialog window to appear.',
      {
        type: 'object',
        properties: {
          titleContains: { type: 'string' },
          timeoutMs: { type: 'number', minimum: 100, default: 5000 },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_ui_wait_for_dialog',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.waitForDialog(
              typeof args.titleContains === 'string' ? args.titleContains : undefined,
              Number(args.timeoutMs || 5000)
            ),
          summary: (data) =>
            data.detected ? 'Detected a Photoshop dialog window.' : 'No Photoshop dialog was detected before the timeout.',
        }),
      true
    ),
    toolDefinition(
      'photoshop_focus_canvas',
      'Bring Photoshop to the foreground as a lightweight canvas-focus fallback.',
      {
        type: 'object',
        properties: {
          titleContains: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_focus_canvas',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.focusWindow(
              typeof args.titleContains === 'string' ? args.titleContains : undefined
            ),
          summary: (data) =>
            data.focused ? 'Photoshop window was focused.' : 'Photoshop window focus could not be confirmed.',
        }),
      false
    ),
    toolDefinition(
      'photoshop_capture_window_snapshot',
      'Capture a screenshot of the current Photoshop window to a PNG file.',
      {
        type: 'object',
        properties: {
          titleContains: { type: 'string' },
          outputPath: { type: 'string' },
          includeBase64: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_capture_window_snapshot',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.captureWindowSnapshot(
              typeof args.titleContains === 'string' ? args.titleContains : undefined,
              typeof args.outputPath === 'string' ? args.outputPath : undefined,
              Boolean(args.includeBase64)
            ),
          summary: (data) => `Captured Photoshop window snapshot to ${String(data.path || 'a temporary file')}.`,
        }),
      true
    ),
    toolDefinition(
      'photoshop_capture_canvas_snapshot',
      'Capture a Photoshop window snapshot as a first-pass canvas fallback when no script-native preview exists.',
      {
        type: 'object',
        properties: {
          titleContains: { type: 'string' },
          outputPath: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args) =>
        await runOperation({
          toolName: 'photoshop_capture_canvas_snapshot',
          mode: 'ui',
          uiAction: async () =>
            await windowsUi.captureWindowSnapshot(
              typeof args.titleContains === 'string' ? args.titleContains : undefined,
              typeof args.outputPath === 'string' ? args.outputPath : undefined,
              false
            ),
          summary: (data) => `Captured canvas fallback snapshot to ${String(data.path || 'a temporary file')}.`,
          warnings: [
            'This first implementation captures the Photoshop window, which is a coarse canvas fallback.',
          ],
        }),
      true
    ),
  ];
}

export function summarizeToolResult(result: CallToolResult): string {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return formatEnvelopeText(result.structuredContent as never);
  }

  return extractText(result);
}
