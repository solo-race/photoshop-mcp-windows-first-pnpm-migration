import { platform } from 'os';
import { TOOL_ENVELOPE_OUTPUT_SCHEMA, buildExecutionInfo, createEnvelope, createToolResult } from '../core/result.js';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { toPlainObject } from '../core/serializer.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { WindowsUIController, toSendKeys } from '../platform/windows-ui.js';

const ACTION_RECORD_SEPARATOR = '@@@';
const ACTION_FIELD_SEPARATOR = '||';

interface ActionDescriptor {
  actionSetName: string;
  actionName: string;
  actionSetIndex: number;
  actionIndex: number;
}

function toolDefinition(
  name: string,
  description: string,
  inputSchema: ToolDefinition['tool']['inputSchema'],
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

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildListActionsScript(): string {
  return `
(function() {
  function cTID(s) { return app.charIDToTypeID(s); }
  function sTID(s) { return app.stringIDToTypeID(s); }

  var records = [];
  var setIndex = 1;

  while (true) {
    var setRef = new ActionReference();
    setRef.putIndex(sTID('actionSet'), setIndex);

    try {
      var setDesc = executeActionGet(setRef);
      var setName = setDesc.getString(cTID('Nm  '));
      var childCount = 0;

      try {
        childCount = setDesc.getInteger(sTID('numberOfChildren'));
      } catch (countError) {
        childCount = 0;
      }

      for (var actionIndex = 1; actionIndex <= childCount; actionIndex++) {
        try {
          var actionRef = new ActionReference();
          actionRef.putIndex(sTID('action'), actionIndex);
          actionRef.putIndex(sTID('actionSet'), setIndex);

          var actionDesc = executeActionGet(actionRef);
          records.push(
            setName +
              ${JSON.stringify(ACTION_FIELD_SEPARATOR)} +
              actionDesc.getString(cTID('Nm  ')) +
              ${JSON.stringify(ACTION_FIELD_SEPARATOR)} +
              setIndex +
              ${JSON.stringify(ACTION_FIELD_SEPARATOR)} +
              actionIndex
          );
        } catch (actionError) {
        }
      }

      setIndex++;
    } catch (setError) {
      break;
    }
  }

  return records.join(${JSON.stringify(ACTION_RECORD_SEPARATOR)});
})();
  `.trim();
}

export function parseActionListResponse(raw: unknown): ActionDescriptor[] {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }

  return text
    .split(ACTION_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [actionSetName, actionName, actionSetIndex, actionIndex] =
        record.split(ACTION_FIELD_SEPARATOR);

      return {
        actionSetName: actionSetName || '',
        actionName: actionName || '',
        actionSetIndex: Number(actionSetIndex || 0),
        actionIndex: Number(actionIndex || 0),
      };
    })
    .filter((record) => record.actionSetName && record.actionName);
}

async function dismissDialogIfPresent(
  windowsUi: WindowsUIController
): Promise<{ detected: boolean; dismissed: boolean; dialog: Record<string, unknown> | null }> {
  const dialog = await windowsUi.waitForDialog(undefined, 800);
  if (!dialog.detected) {
    return {
      detected: false,
      dismissed: false,
      dialog: null,
    };
  }

  await windowsUi.sendShortcut(toSendKeys('escape'), 'escape');
  return {
    detected: true,
    dismissed: true,
    dialog: toPlainObject(dialog.window),
  };
}

export function createActionTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    toolDefinition(
      'photoshop_list_actions',
      'List installed Photoshop actions and action sets that are available on this machine.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () => await listActions(connection),
      true
    ),
    toolDefinition(
      'photoshop_play_action',
      'Play a recorded action from the Actions palette. On Windows, the tool will attempt to dismiss a blocking dialog if one appears.',
      {
        type: 'object',
        properties: {
          actionName: {
            type: 'string',
            description: 'Name of the action to play',
          },
          actionSetName: {
            type: 'string',
            description: 'Name of the action set containing the action',
          },
          timeoutMs: {
            type: 'number',
            minimum: 500,
            description: 'Optional script timeout in milliseconds. Use a shorter timeout for unattended smoke tests.',
          },
        },
        required: ['actionName', 'actionSetName'],
        additionalProperties: false,
      },
      async (args) => await playAction(connection, args),
      false
    ),
    {
      tool: {
        name: 'photoshop_execute_script',
        description:
          'Execute arbitrary ExtendScript directly in Photoshop. Escape hatch only: output is not guaranteed to be structured or stable.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Raw ExtendScript code to execute without guard rails',
            },
          },
          required: ['code'],
        },
      },
      handler: async (args) => executeCustomScript(connection, args),
    },
  ];
}

async function listActions(connection: PhotoshopConnection): Promise<ToolResult> {
  const startedAt = Date.now();

  try {
    const raw = await connection.executeScript(buildListActionsScript(), 30000);
    const actions = parseActionListResponse(raw);

    return createToolResult(
      createEnvelope({
        ok: true,
        summary:
          actions.length > 0
            ? `Found ${actions.length} installed Photoshop action(s).`
            : 'No installed Photoshop actions were found on this machine.',
        data: {
          total: actions.length,
          actions,
        },
        warnings: [],
        context: {},
        execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, false),
        nextSuggestedActions:
          actions.length > 0
            ? ['Use photoshop_play_action with actionName and actionSetName to run a candidate action.']
            : ['Install or load a Photoshop action set before retrying.'],
      })
    );
  } catch (error) {
    const message = extractErrorMessage(error);
    return createToolResult(
      createEnvelope({
        ok: false,
        summary: `Failed to list Photoshop actions: ${message}`,
        data: {
          error: message,
        },
        warnings: [],
        context: {},
        execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, false),
        nextSuggestedActions: ['Verify Photoshop is ready, then retry photoshop_list_actions.'],
      })
    );
  }
}

async function playAction(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const actionName = args.actionName as string;
  const actionSetName = args.actionSetName as string;
  const timeoutMs = Math.max(500, Number(args.timeoutMs || 30000));
  const startedAt = Date.now();
  const warnings: string[] = [];
  let fallbackUsed = false;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();
    const script = ExtendScriptSnippets.playAction(actionName, actionSetName);
    const result = await api.executeScript(script, timeoutMs);

    return createToolResult(
      createEnvelope({
        ok: true,
        summary: `Action played: "${actionName}" from set "${actionSetName}".`,
        data: {
          actionName,
          actionSetName,
          timeoutMs,
          result: toPlainObject(result),
        },
        warnings,
        context: {},
        execution: buildExecutionInfo('script', 'script', Date.now() - startedAt, fallbackUsed),
        nextSuggestedActions: ['Inspect the edited document state or save/export the result if needed.'],
      })
    );
  } catch (error) {
    const message = extractErrorMessage(error);
    let dialogDetected = false;
    let dialogDismissed = false;
    let dialogInfo: Record<string, unknown> | null = null;

    if (platform() === 'win32') {
      try {
        const windowsUi = new WindowsUIController();
        const dialogResult = await dismissDialogIfPresent(windowsUi);
        dialogDetected = dialogResult.detected;
        dialogDismissed = dialogResult.dismissed;
        dialogInfo = dialogResult.dialog;

        if (dialogDismissed) {
          fallbackUsed = true;
          warnings.push('A Photoshop dialog appeared during action playback and was dismissed with Escape.');
        }
      } catch (uiError) {
        warnings.push(`Dialog recovery attempt failed: ${extractErrorMessage(uiError)}`);
      }
    }

    const summary = dialogDetected
      ? `Action "${actionName}" from set "${actionSetName}" appears to require interactive confirmation on this machine.`
      : `Error playing action "${actionName}" from set "${actionSetName}": ${message}`;

    const nextSuggestedActions = dialogDetected
      ? [
          'Choose a different action for unattended execution, or run this action manually inside Photoshop.',
          'Use photoshop_list_actions to inspect other installed actions.',
        ]
      : ['Retry with a longer timeout if the action is expected to take longer.'];

    return createToolResult(
      createEnvelope({
        ok: false,
        summary,
        data: {
          actionName,
          actionSetName,
          timeoutMs,
          error: message,
          dialogDetected,
          dialogDismissed,
          dialog: dialogInfo,
        },
        warnings,
        context: {},
        execution: buildExecutionInfo(
          dialogDetected ? 'auto' : 'script',
          'script',
          Date.now() - startedAt,
          fallbackUsed
        ),
        nextSuggestedActions,
      })
    );
  }
}

async function executeCustomScript(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const code = args.code as string;

  try {
    const script = ExtendScriptSnippets.executeCustomScript(code);
    const result = await connection.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Custom script executed (escape hatch)\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error executing custom script: ${extractErrorMessage(error)}`,
        },
      ],
      isError: true,
    };
  }
}
