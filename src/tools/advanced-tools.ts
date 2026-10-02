import type { ToolDefinition } from '../core/tool-registry.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { toExtendScriptValue } from '../core/serializer.js';
import {
  buildGetActiveContextScript,
  buildGetLayerTreeScript,
  buildGetLayerInfoScript,
  buildGetSelectionBoundsScript,
  buildGetHistoryScript,
  buildFindLayersScript,
  buildResizeCanvasScript,
  buildSaveCopyScript,
} from '../state/script-library.js';

type Execute = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const detail = { type: 'string', enum: ['minimal', 'normal'], default: 'minimal' };

export function createAdvancedTools(
  connection: PhotoshopConnection,
  execute: Execute
): ToolDefinition[] {
  const run = async (script: string) => {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    return await api.executeScript(script);
  };
  const define = (
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    handler: ToolDefinition['handler']
  ): ToolDefinition => ({
    tool: {
      name,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
    },
    handler,
  });
  const stateTools = [
    'photoshop_get_state',
    'photoshop_get_active_context',
    'photoshop_get_document_tree',
  ].map((name) =>
    define(
      name,
      'Inspect only the explicitly authorized document; minimal detail by default.',
      { responseDetail: detail },
      [],
      async (a) =>
        text(
          await run(
            buildGetActiveContextScript(a.responseDetail === 'normal' ? 'normal' : 'minimal')
          )
        )
    )
  );
  return [
    ...stateTools,
    define(
      'photoshop_get_open_documents',
      'List IDs and relative paths of documents in this registered project only.',
      {},
      [],
      async () => {
        throw new Error('POLICY_REQUIRED');
      }
    ),
    define('photoshop_get_layer_tree', 'Read the selected document layer tree.', {}, [], async () =>
      text(await run(buildGetLayerTreeScript(undefined, 'normal')))
    ),
    define('photoshop_get_layer_info', 'Read the explicitly selected layer.', {}, [], async () =>
      text(await run(buildGetLayerInfoScript(undefined, undefined, 'normal')))
    ),
    define(
      'photoshop_get_selection_bounds',
      'Read selection bounds of the selected document.',
      {},
      [],
      async () => text(await run(buildGetSelectionBoundsScript()))
    ),
    define('photoshop_get_history', 'Read history of the selected document.', {}, [], async () =>
      text(await run(buildGetHistoryScript(undefined, 'normal')))
    ),
    ...[false, true].map((textOnly) =>
      define(
        textOnly ? 'photoshop_find_text_layers' : 'photoshop_find_layers',
        'Find layers within the selected document.',
        {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['contains', 'exact'] },
        },
        ['query'],
        async (a) =>
          text(
            await run(
              buildFindLayersScript(
                undefined,
                String(a.query),
                a.mode === 'exact' ? 'exact' : 'contains',
                textOnly
              )
            )
          )
      )
    ),
    define('photoshop_select_document', 'Select a registered document by ID.', {}, [], async () =>
      text(await run('return {id: app.activeDocument.id};'))
    ),
    define(
      'photoshop_select_layer',
      'Select a layer by ID within a registered document.',
      {},
      [],
      async () => text(await run('return {id: app.activeDocument.activeLayer.id};'))
    ),
    define(
      'photoshop_duplicate_document',
      'Create a session-bound working copy of the selected document.',
      { newName: { type: 'string' } },
      [],
      async (a) => {
        const result = (await run(
          `var copy = app.activeDocument.duplicate(${toExtendScriptValue(String(a.newName ?? 'Working copy'))}, false); return {id: copy.id};`
        )) as { id: number };
        return { ...text(result), structuredContent: result };
      }
    ),
    define(
      'photoshop_resize_canvas',
      'Resize the selected document canvas; no implicit fitting.',
      {
        width: { type: 'integer', minimum: 1, maximum: 32768 },
        height: { type: 'integer', minimum: 1, maximum: 32768 },
      },
      ['width', 'height'],
      async (a) =>
        text(await run(buildResizeCanvasScript(undefined, a.width as number, a.height as number)))
    ),
    ...['photoshop_save_copy', 'photoshop_export_document'].map((name) =>
      define(
        name,
        'Save a copy within registered output paths; source document is not rebound.',
        {
          path: { type: 'string' },
          format: { type: 'string', enum: ['PSD', 'PNG', 'JPEG'] },
          quality: { type: 'integer', minimum: 1, maximum: 12 },
        },
        ['path'],
        async (a) =>
          text(
            await run(
              buildSaveCopyScript(
                undefined,
                a.path as string,
                (a.format ?? 'PSD') as 'PSD' | 'PNG' | 'JPEG',
                (a.quality ?? 8) as number
              )
            )
          )
      )
    ),
    define(
      'photoshop_export_layer_preview',
      'Export an isolated layer/group from a temporary duplicate as a local PNG, keeping full canvas, masks and effects. No image bytes are returned.',
      { path: { type: 'string' } },
      ['path'],
      async (a) => {
        await run(`
var source = app.activeDocument;
var selectedId = source.activeLayer.id;
function locate(container, trail) {
  for (var i = 0; i < container.layers.length; i++) {
    var layer = container.layers[i]; var next = trail.concat([i]);
    if (layer.id === selectedId) return next;
    if (layer.typename === 'LayerSet') { var found = locate(layer, next); if (found) return found; }
  }
  return null;
}
var trail = locate(source, []);
if (!trail) throw new Error('TARGET_LAYER_CHANGED');
// Clipping groups require a separate compositing contract; do not silently change them.
var cursor = source;
for (var t = 0; t < trail.length; t++) {
  for (var q = 0; q < cursor.layers.length; q++) {
    if (cursor.layers[q].grouped) throw new Error('CLIPPED_PREVIEW_UNSUPPORTED');
  }
  cursor = cursor.layers[trail[t]];
}
var copy = null;
try {
  copy = source.duplicate('MCP local preview', false);
  var container = copy;
  for (var depth = 0; depth < trail.length; depth++) {
    for (var j = 0; j < container.layers.length; j++) container.layers[j].visible = j === trail[depth];
    container = container.layers[trail[depth]];
  }
  var options = new PNGSaveOptions(); options.compression = 9;
  copy.saveAs(new File(${toExtendScriptValue(a.path as string)}), options, true);
} finally {
  if (copy) copy.close(SaveOptions.DONOTSAVECHANGES);
  app.activeDocument = source;
}
return {exported: true};`);
        return text({
          path: a.path,
          delivery: 'local-only',
          canvas: 'unchanged',
          masksAndEffects: 'applied',
          validation: 'UNVERIFIED_IN_PHOTOSHOP',
        });
      }
    ),
    define(
      'photoshop_run_sequence',
      'Execute up to 20 authorized steps serially. Not a transaction; failure stops with no automatic rollback.',
      {
        task_id: { type: 'string' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              args: { type: 'object', delegateToolArguments: true },
            },
            required: ['tool', 'args'],
          },
        },
      },
      ['steps'],
      async (a) => {
        const results = [];
        for (const step of a.steps as { tool: string; args: Record<string, unknown> }[]) {
          if (step.tool === 'photoshop_run_sequence') throw new Error('NESTED_WORKFLOW_DENIED');
          if (step.args.project_id !== undefined && step.args.project_id !== a.project_id)
            throw new Error('CROSS_PROJECT_WORKFLOW_DENIED');
          if (a.task_id && step.args.task_id !== undefined && step.args.task_id !== a.task_id)
            throw new Error('CROSS_TASK_WORKFLOW_DENIED');
          const result = await execute(step.tool, {
            ...step.args,
            project_id: a.project_id,
            ...(a.task_id ? { task_id: a.task_id } : {}),
          });
          results.push({ tool: step.tool, result });
          if (result.isError) return { ...text({ results, stopped: true }), isError: true };
        }
        return text({ results, stopped: false });
      }
    ),
  ];
}
