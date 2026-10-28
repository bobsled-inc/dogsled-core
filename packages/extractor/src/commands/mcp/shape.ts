export type ShapeNode =
  | { kind: 'unknown'; nullable?: true }
  | { kind: 'null' }
  | { kind: 'string'; format?: string; nullable?: true }
  | { kind: 'number'; nullable?: true }
  | { kind: 'integer'; nullable?: true }
  | { kind: 'boolean'; nullable?: true }
  | { kind: 'array'; items: ShapeNode; nullable?: true }
  | { kind: 'object'; fields: Record<string, ShapeNode>; nullable?: true };

const VALUE_SCHEMA_KEYWORDS = new Set([
  'const',
  'default',
  'enum',
  'example',
  'examples',
  'sample',
  'samples',
]);

export function inferShapeFromOutputSchema(schema: unknown): ShapeNode {
  return inferShapeFromSanitizedSchema(sanitizeJsonSchema(schema));
}

export function inferShapeFromDryRun(value: unknown): ShapeNode {
  return inferShapeFromValue(value);
}

const MAX_SHAPE_DEPTH = 64;

export function sanitizeJsonSchema(schema: unknown, depth = 0): unknown {
  if (depth > MAX_SHAPE_DEPTH) return schema;

  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeJsonSchema(entry, depth + 1));
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (VALUE_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    result[key] = sanitizeJsonSchema(value, depth + 1);
  }
  return result;
}

function inferShapeFromSanitizedSchema(schema: unknown, depth = 0): ShapeNode {
  if (depth > MAX_SHAPE_DEPTH || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { kind: 'unknown' };
  }

  const record = schema as Record<string, unknown>;
  const { type, nullable } = normalizeSchemaType(record.type);

  if (type === 'object' || record.properties) {
    const properties =
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    return withNullable(
      {
        kind: 'object',
        fields: Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [
            key,
            inferShapeFromSanitizedSchema(value, depth + 1),
          ])
        ),
      },
      nullable
    );
  }

  if (type === 'array') {
    return withNullable(
      {
        kind: 'array',
        items: inferShapeFromSanitizedSchema(record.items, depth + 1),
      },
      nullable
    );
  }

  if (type === 'string') {
    return withNullable(
      {
        kind: 'string',
        ...(typeof record.format === 'string' ? { format: record.format } : {}),
      },
      nullable
    );
  }
  if (type === 'number') return withNullable({ kind: 'number' }, nullable);
  if (type === 'integer') return withNullable({ kind: 'integer' }, nullable);
  if (type === 'boolean') return withNullable({ kind: 'boolean' }, nullable);
  if (type === 'null') return { kind: 'null' };

  return withNullable({ kind: 'unknown' }, nullable);
}

function normalizeSchemaType(type: unknown): { type: unknown; nullable: boolean } {
  if (!Array.isArray(type)) {
    return { type, nullable: false };
  }

  return {
    type: type.find((entry) => entry !== 'null') ?? 'null',
    nullable: type.includes('null'),
  };
}

function withNullable<T extends ShapeNode>(shape: T, nullable: boolean): T {
  return nullable && shape.kind !== 'null' ? ({ ...shape, nullable: true } as T) : shape;
}

function inferShapeFromValue(value: unknown, depth = 0): ShapeNode {
  if (depth > MAX_SHAPE_DEPTH) return { kind: 'unknown' };
  if (value === null) return { kind: 'null' };
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      items: value.length > 0 ? inferShapeFromValue(value[0], depth + 1) : { kind: 'unknown' },
    };
  }
  if (typeof value === 'string') {
    return { kind: 'string' };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { kind: 'integer' } : { kind: 'number' };
  }
  if (typeof value === 'boolean') {
    return { kind: 'boolean' };
  }
  if (value && typeof value === 'object') {
    return {
      kind: 'object',
      fields: Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, inferShapeFromValue(entry, depth + 1)])
      ),
    };
  }
  return { kind: 'unknown' };
}
