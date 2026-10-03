import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  ExecutionMode,
  ExecutionStrategy,
  ResponseDetail,
  ToolEnvelope,
  ToolExecutionInfo,
} from './models.js';

interface EnvelopeOptions<TData> {
  ok: boolean;
  summary: string;
  data?: TData;
  warnings?: string[];
  context?: Record<string, unknown>;
  execution: ToolExecutionInfo;
  nextSuggestedActions?: string[];
}

export const TOOL_ENVELOPE_OUTPUT_SCHEMA: {
  type: 'object';
  properties: Record<string, object>;
  required: string[];
  additionalProperties: boolean;
} = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
    context: { type: 'object', additionalProperties: true },
    execution: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['script', 'ui', 'auto'] },
        strategy: { type: 'string', enum: ['script', 'ui', 'workflow', 'resource'] },
        durationMs: { type: 'number' },
        fallbackUsed: { type: 'boolean' },
      },
      required: ['mode', 'strategy', 'durationMs', 'fallbackUsed'],
      additionalProperties: false,
    },
    nextSuggestedActions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['ok', 'summary', 'data', 'warnings', 'context', 'execution', 'nextSuggestedActions'],
  additionalProperties: false,
};

export function buildExecutionInfo(
  mode: ExecutionMode,
  strategy: ExecutionStrategy,
  durationMs: number,
  fallbackUsed = false
): ToolExecutionInfo {
  return {
    mode,
    strategy,
    durationMs,
    fallbackUsed,
  };
}

export function createEnvelope<TData = Record<string, unknown>>(
  options: EnvelopeOptions<TData>
): ToolEnvelope<TData> {
  return {
    ok: options.ok,
    summary: options.summary,
    data: (options.data ?? {}) as TData,
    warnings: options.warnings ?? [],
    context: options.context ?? {},
    execution: options.execution,
    nextSuggestedActions: options.nextSuggestedActions ?? [],
  };
}

export function formatEnvelopeText<TData>(envelope: ToolEnvelope<TData>): string {
  const lines = [envelope.summary];

  if (envelope.warnings.length > 0) {
    lines.push(`Warnings: ${envelope.warnings.join(' | ')}`);
  }

  if (envelope.nextSuggestedActions.length > 0) {
    lines.push(`Next: ${envelope.nextSuggestedActions.join(' | ')}`);
  }

  return lines.join('\n');
}

export function createToolResult<TData>(envelope: ToolEnvelope<TData>): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: formatEnvelopeText(envelope),
      },
    ],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: !envelope.ok,
  };
}

export function responseDetailFromArgs(
  value: unknown,
  fallback: ResponseDetail = 'normal'
): ResponseDetail {
  if (value === 'minimal' || value === 'normal' || value === 'full') {
    return value;
  }

  return fallback;
}
