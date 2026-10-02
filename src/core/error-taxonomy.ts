import type { ErrorCategory, LastErrorRecord } from './models.js';

function normalizeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function categorizeError(error: unknown, toolName?: string): LastErrorRecord {
  const message = normalizeMessage(error);
  const normalized = message.toLowerCase();

  let category: ErrorCategory = 'unknown';
  let retryable = false;
  let suggestedActions: string[] = ['Retry after checking Photoshop is open and ready.'];

  if (normalized.includes('timeout')) {
    category = 'timeout';
    retryable = true;
    suggestedActions = [
      'Retry with a longer timeout.',
      'Wait for Photoshop to finish any modal or startup work first.',
    ];
  } else if (
    normalized.includes('failed to connect') ||
    normalized.includes('photoshop not found') ||
    normalized.includes('unsupported platform')
  ) {
    category = 'connection';
    retryable = true;
    suggestedActions = [
      'Verify PHOTOSHOP_PATH points to Photoshop.exe.',
      'Launch Photoshop once manually and try again.',
    ];
  } else if (normalized.includes('no active document')) {
    category = 'no-document';
    suggestedActions = [
      'Open or create a document before running this tool.',
      'Use photoshop_create_document or photoshop_open_image first.',
    ];
  } else if (normalized.includes('no active layer')) {
    category = 'no-layer';
    suggestedActions = [
      'Select or create a layer first.',
      'Use photoshop_select_layer or photoshop_create_layer.',
    ];
  } else if (
    normalized.includes('layer not found') ||
    normalized.includes('document not found') ||
    normalized.includes('history state not found')
  ) {
    category = 'not-found';
    suggestedActions = [
      'Inspect the current document or layer tree before retrying.',
      'Use photoshop_get_state or photoshop_get_layer_tree to confirm the target.',
    ];
  } else if (
    normalized.includes('no selection') ||
    normalized.includes('selection is empty')
  ) {
    category = 'selection-empty';
    suggestedActions = [
      'Create a selection first.',
      'Use photoshop_select_rectangle or related registered selection tools.',
    ];
  } else if (
    normalized.includes('modal') ||
    normalized.includes('dialog') ||
    normalized.includes('user cancelled')
  ) {
    category = 'dialog-blocked';
    retryable = true;
    suggestedActions = [
      'Ask the user to inspect and resolve the dialog locally.',
    ];
  } else if (
    normalized.includes('not currently available') ||
    normalized.includes('only available from the user interface')
  ) {
    category = 'ui-required';
    retryable = true;
    suggestedActions = [
      'This operation requires a manual Photoshop step; no UI fallback is exposed.',
    ];
  } else if (
    normalized.includes('invalid') ||
    normalized.includes('missing required') ||
    normalized.includes('must be')
  ) {
    category = 'invalid-argument';
    suggestedActions = ['Adjust the tool arguments and retry.'];
  } else if (
    normalized.includes('photoshop error') ||
    normalized.includes('general photoshop error') ||
    normalized.includes('error number')
  ) {
    category = 'script-execution';
    retryable = true;
    suggestedActions = [
      'Retry after checking the active document state.',
      'Ask the user to resolve UI-only steps manually.',
    ];
  }

  return {
    timestamp: new Date().toISOString(),
    toolName,
    category,
    message,
    retryable,
    suggestedActions,
    raw: undefined,
  };
}

export function shouldUseUiFallback(error: unknown): boolean {
  const category = categorizeError(error).category;
  return category === 'dialog-blocked' || category === 'ui-required';
}
