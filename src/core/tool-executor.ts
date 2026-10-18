import path from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from './tool-registry.js';
import { PhotoshopConnection, type ScriptScope } from '../platform/connection.js';
import { validate, type Schema } from '../security/validation.js';

export const disabledTools = new Set([
  'photoshop_execute_script',
  'photoshop_execute_script_with_state',
  'photoshop_send_shortcut',
  'photoshop_play_action',
  'photoshop_list_actions',
  'photoshop_run_transaction',
  'photoshop_recover_last_error',
  'photoshop_capture_canvas_snapshot',
  'photoshop_capture_window_snapshot',
  'photoshop_get_ui_snapshot',
  'photoshop_ui_wait_for_dialog',
  'photoshop_focus_canvas',
  'photoshop_snapshot_checkpoint',
  'photoshop_restore_checkpoint',
  'photoshop_select_history_state',
  'photoshop_undo',
  'photoshop_redo',
]);
const diagnostics = new Set([
  'photoshop_ping',
  'photoshop_get_version',
  'photoshop_get_capabilities',
]);
const reads = new Set([
  'photoshop_get_state',
  'photoshop_get_open_documents',
  'photoshop_get_document_tree',
  'photoshop_get_active_context',
  'photoshop_get_layer_tree',
  'photoshop_get_layer_info',
  'photoshop_get_selection_bounds',
  'photoshop_get_history',
  'photoshop_find_layers',
  'photoshop_find_text_layers',
  'photoshop_get_document_info',
  'photoshop_get_layers',
]);
const creators = new Set(['photoshop_create_document', 'photoshop_duplicate_document']);
const fileTools: Record<string, { key: string; write?: boolean }> = {
  photoshop_open_image: { key: 'filePath' },
  photoshop_place_image: { key: 'filePath' },
  photoshop_save_document: { key: 'path', write: true },
  photoshop_save_copy: { key: 'path', write: true },
  photoshop_export_document: { key: 'path', write: true },
  photoshop_export_layer_preview: { key: 'path', write: true },
};
const noLayer = new Set([
  ...reads,
  ...diagnostics,
  ...creators,
  'photoshop_open_image',
  'photoshop_select_document',
  'photoshop_close_document',
  'photoshop_save_document',
  'photoshop_save_copy',
  'photoshop_export_document',
  'photoshop_create_layer',
  'photoshop_create_text_layer',
  'photoshop_place_image',
  'photoshop_resize_image',
  'photoshop_resize_canvas',
  'photoshop_crop_document',
  'photoshop_select_rectangle',
  'photoshop_select_all',
  'photoshop_deselect',
  'photoshop_invert_selection',
  'photoshop_merge_visible_layers',
  'photoshop_flatten_image',
  'photoshop_run_sequence',
]);
const idSchema = { type: 'integer', minimum: 1, maximum: 2147483647 };
export class ToolExecutor {
  constructor(private connection: PhotoshopConnection) {}

  decorate(definition: ToolDefinition): ToolDefinition {
    const name = definition.tool.name;
    const schema = definition.tool.inputSchema;
    const properties: Record<string, unknown> = { ...(schema.properties ?? {}) };
    const required = [...(schema.required ?? [])];
    if (!diagnostics.has(name)) {
      if (
        ![
          'photoshop_open_image',
          'photoshop_create_document',
          'photoshop_get_open_documents',
          'photoshop_run_sequence',
        ].includes(name)
      ) {
        properties.document_id = idSchema;
        required.push('document_id');
      }
      if (!noLayer.has(name) || name === 'photoshop_get_layer_info') {
        properties.layer_id = idSchema;
        required.push('layer_id');
      }
    }
    return {
      ...definition,
      tool: {
        ...definition.tool,
        inputSchema: {
          ...schema,
          properties,
          required,
          additionalProperties: false,
        } as Tool['inputSchema'],
      },
    };
  }

  async run(definition: ToolDefinition, input: Record<string, unknown>): Promise<CallToolResult> {
    const name = definition.tool.name;
    if (disabledTools.has(name)) throw new Error('TOOL_DISABLED');
    validate(definition.tool.inputSchema as Schema, input);
    const args = { ...input };
    if (
      diagnostics.has(name) ||
      name === 'photoshop_run_sequence' ||
      name === 'photoshop_get_open_documents'
    )
      return await definition.handler(args);

    const documents = await this.connection.inspectDocuments();
    const id = args.document_id as number | undefined;
    const doc = id === undefined ? undefined : documents.find((d) => d.id === id);
    if (id !== undefined && !doc) throw new Error('DOCUMENT_NOT_FOUND');
    const file = fileTools[name];
    if (file) {
      const resolved = path.resolve(args[file.key] as string);
      if (file.write) {
        const format = String(
          args.format ?? (name === 'photoshop_export_layer_preview' ? 'PNG' : 'PSD')
        ).toLowerCase();
        const ext = path.extname(resolved).slice(1).toLowerCase();
        if (!(ext === format || (format === 'jpeg' && ext === 'jpg')))
          throw new Error('FORMAT_EXTENSION_MISMATCH');
      }
      args[file.key] = resolved;
    }
    if (name === 'photoshop_close_document' && args.save === true)
      throw new Error('IMPLICIT_SAVE_DENIED_USE_SAVE_COPY');
    if (
      typeof args.width === 'number' &&
      typeof args.height === 'number' &&
      args.width * args.height > 100_000_000
    )
      throw new Error('CANVAS_TOO_LARGE');
    const scope: ScriptScope = {
      documentId: id,
      documentPath: doc?.path ?? undefined,
      layerId: args.layer_id as number | undefined,
    };
    const result = await this.connection.withScope(scope, () => definition.handler(args));
    if (result.isError)
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: result.content.some(
              (b) => b.type === 'text' && b.text.includes('RASTERIZATION_REQUIRED')
            )
              ? 'RASTERIZATION_REQUIRED: use photoshop_rasterize_layer before this operation.'
              : 'PHOTOSHOP_OPERATION_FAILED: inspect the selected document locally; no automatic retry or recovery performed.',
          },
        ],
      };
    if (result.content.some((b) => b.type !== 'text')) throw new Error('CONTENT_DELIVERY_DENIED');
    return result;
  }
}
