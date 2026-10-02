/** Runtime validation for the deliberately small schema subset used by this server.
 * Unknown keywords in executable constraints must not silently grant permission.
 */
export type Schema = Record<string, unknown>;
export function validate(schema: Schema, value: unknown, field = 'arguments'): void {
  if (Array.isArray(schema.anyOf)) {
    if (
      !schema.anyOf.some((s) => {
        try {
          validate(s as Schema, value, field);
          return true;
        } catch {
          return false;
        }
      })
    ) {
      throw new Error(`INVALID_ARGUMENT: ${field}`);
    }
    return;
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value))
    throw new Error(`INVALID_ARGUMENT: ${field}`);
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`INVALID_ARGUMENT: ${field}`);
      const obj = value as Record<string, unknown>;
      if (schema.delegateToolArguments === true) return; // Validated by the named child tool before execution.
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(obj, key)) throw new Error(`MISSING_ARGUMENT: ${field}.${key}`);
      }
      for (const [key, item] of Object.entries(obj)) {
        if (!Object.hasOwn(props, key)) throw new Error(`UNKNOWN_ARGUMENT: ${field}.${key}`);
        validate(props[key], item, `${field}.${key}`);
      }
      break;
    }
    case 'string':
      if (
        typeof value !== 'string' ||
        value.length > Number(schema.maxLength ?? 4096) ||
        value.includes(String.fromCharCode(0))
      )
        throw new Error(`INVALID_ARGUMENT: ${field}`);
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > Number(schema.maximum ?? 1e7) ||
        (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
        value < Number(schema.minimum ?? -1e7) ||
        value > Number(schema.maximum ?? 1e7)
      )
        throw new Error(`INVALID_ARGUMENT: ${field}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`INVALID_ARGUMENT: ${field}`);
      break;
    case 'array':
      if (
        !Array.isArray(value) ||
        value.length > Number(schema.maxItems ?? 100) ||
        value.length < Number(schema.minItems ?? 0)
      )
        throw new Error(`INVALID_ARGUMENT: ${field}`);
      for (const item of value) validate(schema.items as Schema, item, field);
      break;
    default:
      throw new Error(`UNSUPPORTED_SCHEMA: ${field}`);
  }
}
