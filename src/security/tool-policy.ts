import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../core/tool-registry.js';
import { PhotoshopConnection, type ScriptScope } from '../platform/connection.js';
import { ProjectPolicy, relativePath, inside, matchesGrantedPath } from './project-policy.js';
import { validate, type Schema } from './validation.js';

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
const destructive = new Set([
  'photoshop_delete_layer',
  'photoshop_merge_visible_layers',
  'photoshop_flatten_image',
  'photoshop_rasterize_layer',
  'photoshop_delete_layer_mask',
  'photoshop_apply_layer_mask',
  'photoshop_close_document',
]);
const creators = new Set(['photoshop_create_document', 'photoshop_duplicate_document']);
const fileTools: Record<string, { key: string; mode: 'read' | 'write' }> = {
  photoshop_open_image: { key: 'filePath', mode: 'read' },
  photoshop_place_image: { key: 'filePath', mode: 'read' },
  photoshop_save_document: { key: 'path', mode: 'write' },
  photoshop_save_copy: { key: 'path', mode: 'write' },
  photoshop_export_document: { key: 'path', mode: 'write' },
  photoshop_export_layer_preview: { key: 'path', mode: 'write' },
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
export class ToolPolicy {
  private bindings = new Map<number, { project: string; task: string }>();
  private nested = new AsyncLocalStorage<{ project: string; task: unknown }>();
  constructor(
    readonly projects: ProjectPolicy,
    private connection: PhotoshopConnection
  ) {}

  decorate(definition: ToolDefinition): ToolDefinition {
    const name = definition.tool.name;
    const schema = definition.tool.inputSchema;
    const properties: Record<string, unknown> = { ...(schema.properties ?? {}) };
    const required = [...(schema.required ?? [])];
    if (!diagnostics.has(name)) {
      properties.project_id = { type: 'string' };
      properties.task_id = { type: 'string' };
      required.push('project_id');
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
      if (!reads.has(name) && name !== 'photoshop_run_sequence') {
        properties.task_id = { type: 'string' };
        required.push('task_id');
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
    await this.projects.unchanged();
    const args = { ...input };
    if (diagnostics.has(name)) return await definition.handler(args);
    const project = this.projects.get(args.project_id);
    const parent = this.nested.getStore();
    if (parent && (parent.project !== project.id || (args.task_id && parent.task !== args.task_id)))
      throw new Error('CROSS_PROJECT_WORKFLOW_DENIED');
    if (name === 'photoshop_run_sequence') {
      if (parent) throw new Error('NESTED_WORKFLOW_DENIED');
      return await this.nested.run({ project: project.id, task: args.task_id }, () =>
        definition.handler(args)
      );
    }
    const documents = await this.connection.inspectDocuments();
    if (name === 'photoshop_get_open_documents') {
      const visible = [];
      for (const doc of documents) {
        try {
          if (doc.path) await this.projects.documentPath(project, doc.path);
          else if (this.bindings.get(doc.id)?.project !== project.id) continue;
          visible.push({
            id: doc.id,
            path: doc.path ? path.relative(project.root, doc.path) : null,
          });
        } catch {
          /* Unrelated documents must not appear in the response. */
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ documents: visible }) }] };
    }
    const id = args.document_id as number | undefined;
    const doc = id === undefined ? undefined : documents.find((d) => d.id === id);
    if (id !== undefined && !doc) throw new Error('DOCUMENT_NOT_REGISTERED');
    let docPath: string | undefined;
    if (doc) {
      if (doc.path) docPath = await this.projects.documentPath(project, doc.path);
      else if (this.bindings.get(doc.id)?.project !== project.id)
        throw new Error('UNBOUND_DOCUMENT');
    }
    let grant;
    const isCreate = creators.has(name);
    if (!reads.has(name) && name !== 'photoshop_open_image') {
      grant = this.projects.grant(
        project,
        args.task_id,
        name,
        docPath,
        !docPath && (isCreate || !!doc),
        destructive.has(name)
      );
      if (isCreate && !grant.allow_new_documents) throw new Error('NEW_DOCUMENT_DENIED');
      if (!docPath && doc && this.bindings.get(doc.id)?.task !== args.task_id)
        throw new Error('TASK_DOCUMENT_DENIED');
    }
    // Opening a file is an app-state change; authorize against its actual path.
    const file = fileTools[name];
    let resolved: string | undefined;
    let overwrite = false;
    if (file) {
      const rel = relativePath(args[file.key]);
      overwrite = matchesGrantedPath(
        project.root,
        grant?.overwrite_paths ?? [],
        path.join(project.root, rel)
      );
      resolved = await this.projects.resolve(project, rel, file.mode, overwrite);
      if (name === 'photoshop_open_image')
        this.projects.grant(project, args.task_id, name, resolved);
      if (file.mode === 'write') {
        if (!matchesGrantedPath(project.root, grant?.output_paths ?? [], resolved))
          throw new Error('TASK_OUTPUT_DENIED');
        const format = String(
          args.format ?? (name === 'photoshop_export_layer_preview' ? 'PNG' : 'PSD')
        ).toLowerCase();
        const ext = path.extname(resolved).slice(1).toLowerCase();
        if (!(ext === format || (format === 'jpeg' && ext === 'jpg')))
          throw new Error('FORMAT_EXTENSION_MISMATCH');
        if (
          name === 'photoshop_export_layer_preview' &&
          (!project.preview_path ||
            !inside(path.join(project.root, relativePath(project.preview_path)), resolved))
        )
          throw new Error('PREVIEW_PATH_DENIED');
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
    const recheck = async () => {
      await this.projects.unchanged();
      if (docPath) await this.projects.documentPath(project, docPath);
      if (!reads.has(name) && name !== 'photoshop_open_image')
        this.projects.grant(
          project,
          args.task_id,
          name,
          docPath,
          !docPath && (isCreate || !!doc),
          destructive.has(name)
        );
      if (name === 'photoshop_open_image')
        this.projects.grant(project, args.task_id, name, resolved);
      if (file && resolved)
        await this.projects.resolve(
          project,
          path.relative(project.root, resolved),
          file.mode,
          overwrite
        );
    };
    const scope: ScriptScope = {
      documentId: id,
      documentPath: docPath,
      layerId: args.layer_id as number | undefined,
      recheck,
    };
    const result = await this.connection.withScope(scope, () => definition.handler(args));
    // Legacy handlers include error strings with absolute paths. Return only a safe failure.
    if (result.isError)
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: result.content.some(
              (b) => b.type === 'text' && b.text.includes('RASTERIZATION_REQUIRED')
            )
              ? 'RASTERIZATION_REQUIRED: separately authorize photoshop_rasterize_layer before this operation.'
              : 'PHOTOSHOP_OPERATION_FAILED: inspect the selected document locally; no automatic retry or recovery performed.',
          },
        ],
      };
    if (isCreate) {
      const newId = (result.structuredContent as { id?: number } | undefined)?.id;
      if (!Number.isSafeInteger(newId)) throw new Error('CREATED_DOCUMENT_BINDING_FAILED');
      this.bindings.set(newId!, { project: project.id, task: String(args.task_id) });
    }
    if (name === 'photoshop_close_document' && id) this.bindings.delete(id);
    // This runtime has no image delivery route. Redact machine paths even inside serialized text.
    let clean = JSON.stringify(result);
    const variants = [
      project.root,
      project.root.replace(/\\/g, '/'),
      project.root.replace(/\//g, '\\'),
    ];
    for (const root of variants) {
      let encoded = root;
      for (let depth = 0; depth < 3; depth++) {
        const escaped = encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        clean = clean.replace(new RegExp(escaped, 'gi'), '[project]');
        encoded = JSON.stringify(encoded).slice(1, -1);
      }
    }
    const output = JSON.parse(clean) as CallToolResult;
    if (output.content.some((b) => b.type !== 'text')) throw new Error('CONTENT_DELIVERY_DENIED');
    return output;
  }
}
