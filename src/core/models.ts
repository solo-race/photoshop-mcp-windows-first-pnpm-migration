export type ResponseDetail = 'minimal' | 'normal' | 'full';

export type ExecutionMode = 'script' | 'ui' | 'auto';

export type ExecutionStrategy = 'script' | 'ui' | 'workflow' | 'resource';

export type ErrorCategory =
  | 'connection'
  | 'timeout'
  | 'no-document'
  | 'no-layer'
  | 'not-found'
  | 'selection-empty'
  | 'dialog-blocked'
  | 'ui-required'
  | 'invalid-argument'
  | 'script-execution'
  | 'unknown';

export interface DocumentRef {
  by: 'active' | 'id' | 'name' | 'index';
  value?: string | number;
}

export interface LayerRef {
  by: 'active' | 'id' | 'name' | 'index' | 'path';
  value?: string | number;
}

export interface ToolExecutionInfo {
  mode: ExecutionMode;
  strategy: ExecutionStrategy;
  durationMs: number;
  fallbackUsed: boolean;
}

export interface ToolEnvelope<TData = Record<string, unknown>> {
  ok: boolean;
  summary: string;
  data: TData;
  warnings: string[];
  context: Record<string, unknown>;
  execution: ToolExecutionInfo;
  nextSuggestedActions: string[];
}

export interface LastErrorRecord {
  timestamp: string;
  toolName?: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  suggestedActions: string[];
  raw?: string;
}

export interface DiagnosticsInfo {
  name: string;
  version: string;
  build: string;
  detectedPath: string;
  detectedYear: string;
  isRunning: boolean;
  canExecuteScript: boolean;
  executionModesAvailable: ExecutionMode[];
}

export interface SequenceStep {
  tool: string;
  args?: Record<string, unknown>;
  stopOnError?: boolean;
}

export interface CheckpointRecord {
  name: string;
  createdAt: string;
  historyStateName: string | null;
  state: Record<string, unknown>;
}
