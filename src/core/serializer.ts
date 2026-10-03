export type ScriptSerializable =
  | string
  | number
  | boolean
  | null
  | ScriptSerializable[]
  | { [key: string]: ScriptSerializable };

function escapeNonAscii(input: string): string {
  return input.replace(/[^\x20-\x7e]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

export function toExtendScriptValue(value: ScriptSerializable | undefined): string {
  return escapeNonAscii(
    JSON.stringify(value === undefined ? null : value)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
  );
}

export function toPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item));
}
