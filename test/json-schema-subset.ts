// A deliberately small JSON Schema evaluator, covering exactly the keywords
// openclaw.plugin.json uses. It exists so manifest tests can assert what the
// gateway would accept and reject, rather than restating the schema's literal
// shape back to itself — a test that only compares the schema to a copy of the
// schema cannot catch a schema that is wrong.
//
// It is not a general validator and must not grow into one. Both entry points
// throw on any keyword they do not implement, so a schema that drifts past this
// subset fails loudly instead of being waved through unchecked.

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'additionalProperties',
  'required',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'anyOf',
  'description',
]);

/** Walks the whole schema up front, so unexercised subschemas cannot hide unsupported keywords. */
export function assertSupportedSchema(schema: unknown, path = ''): void {
  if (!isRecord(schema)) throw new Error(`json-schema-subset: expected a schema object at ${label(path)}`);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`json-schema-subset: unsupported keyword "${keyword}" at ${label(path)}`);
    }
  }
  // Only the closed form is implemented. A subschema here would otherwise read
  // as "not false" and quietly disable the unknown-key check.
  if ('additionalProperties' in schema && schema.additionalProperties !== false) {
    throw new Error(`json-schema-subset: only "additionalProperties": false is implemented, at ${label(path)}`);
  }
  if (isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSupportedSchema(child, path ? `${path}.${key}` : key);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((branch, index) => assertSupportedSchema(branch, `${label(path)}#anyOf[${index}]`));
  }
}

/** Returns one message per violation; an empty array means the value validates. */
export function validateAgainstSchema(schema: unknown, value: unknown, path = ''): string[] {
  if (!isRecord(schema)) throw new Error(`json-schema-subset: expected a schema object at ${label(path)}`);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`json-schema-subset: unsupported keyword "${keyword}" at ${label(path)}`);
    }
  }
  // Only the closed form is implemented. A subschema here would otherwise read
  // as "not false" and quietly disable the unknown-key check.
  if ('additionalProperties' in schema && schema.additionalProperties !== false) {
    throw new Error(`json-schema-subset: only "additionalProperties": false is implemented, at ${label(path)}`);
  }

  const errors: string[] = [];
  const at = label(path);

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((branch) => validateAgainstSchema(branch, value, path).length === 0);
    if (!matched) errors.push(`${at}: matches no anyOf branch`);
  }

  // A type mismatch makes every other keyword at this level meaningless, so
  // report it alone rather than piling on cascading noise.
  if (typeof schema.type === 'string' && !matchesType(schema.type, value)) {
    return [...errors, `${at}: expected type ${schema.type}`];
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: not one of the allowed values`);
  }
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${at}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) errors.push(`${at}: missing required key ${key}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) errors.push(`${at}: unknown key ${key}`);
        continue;
      }
      errors.push(...validateAgainstSchema(childSchema, child, path ? `${path}.${key}` : key));
    }
  }

  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  throw new Error(`json-schema-subset: unsupported type "${type}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function label(path: string): string {
  return path || '<root>';
}
