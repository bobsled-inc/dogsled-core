/**
 * Shared formatter for user-facing Zod-validation failures on
 * Bobsled Core spec YAMLs (integrations, resources, sources, syncs, policies,
 * truthsets, surviorship rules, etc.).
 *
 * Every package that loads a user-authored YAML and runs `.safeParse(...)`
 * should funnel the failure through `reportSpecValidationError` so the
 * surface is identical regardless of which package raised it.
 *
 * Format:
 *   Invalid <kind> spec at <path>
 *     - <field.path>: <message> (code: <code>[; expected: <type>][; got: <type>]
 *       [; accepted: <values>][; discriminator: <field>])
 *
 * Without this formatter the wrapper threw `Invalid integration spec <path>`
 * with no field reference, forcing downstream tools to inspect Zod schemas
 * by hand to figure out which YAML field was wrong.
 */

import type { ZodError, ZodIssue, ZodType } from 'zod';

export type SpecValidationKind =
  | 'integration'
  | 'integration_file'
  | 'resource'
  | 'source'
  | 'pipeline'
  | 'models'
  | 'project'
  | 'action'
  | 'sync'
  | 'truthset'
  | 'resolution'
  | 'entity_relationship'
  | 'survivorship'
  | 'object'
  | 'policy'
  | 'seed'
  | 'target'
  | 'target_file'
  | 'load block'
  // Accept any string so packages outside this enum can pass their own label
  // (e.g. domain-specific specs) without amending this union.
  | (string & {});

export interface FormatSpecErrorOptions {
  /** Indentation prefix for each issue bullet line. Defaults to "  ". */
  indent?: string;
  /**
   * Optional root Zod schema. When supplied, the formatter walks the issue
   * path to introspect accepted sibling keys for `unrecognized_keys` issues
   * and accepted discriminator values for discriminated-union mismatches.
   * Falls back gracefully (returning no extra context) on any introspection
   * failure.
   */
  schema?: ZodType<unknown>;
  /**
   * Optional trailing hint appended after the issue list. Use sparingly,
   * only when the caller has unique disambiguation context to add (e.g.
   * "expected either a V2 resource YAML or a target YAML").
   */
  hint?: string;
}

function formatSegment(seg: PropertyKey): string {
  if (typeof seg === 'symbol') return seg.toString();
  return String(seg);
}

function buildPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map(formatSegment).join('.');
}

function formatPrimitive(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function describeReceived(issue: ZodIssue): string | null {
  if ('input' in issue) {
    const input = (issue as { input?: unknown }).input;
    if (input === undefined) return 'undefined';
    if (input === null) return 'null';
    if (Array.isArray(input)) return 'array';
    return typeof input;
  }
  // Zod 4 invalid_type issues do not carry `input` for missing fields, but
  // embed "received X" in the human message — pull it back out so the bullet
  // line still shows `got: undefined`.
  const match = /received\s+([\w[\]]+)/i.exec(issue.message);
  return match ? match[1]! : null;
}

// A defensively-typed alias for the internal-but-stable accessors zod uses
// across both v3 and v4. `_zod.def` is the v4 internals surface; `_def` is
// the v3 surface. We tolerate both to keep this formatter working across
// the dual-versioned monorepo.
type ZodLike = {
  shape?: Record<string, unknown>;
  options?: readonly unknown[];
  element?: unknown;
  _zod?: { def?: ZodDef };
  _def?: ZodDef;
};

type ZodDef = {
  type?: string;
  typeName?: string;
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  schema?: unknown;
  getter?: () => unknown;
  options?: readonly unknown[];
  element?: unknown;
  left?: unknown;
  right?: unknown;
  values?: readonly unknown[];
  value?: unknown;
  entries?: Record<string, unknown>;
};

function getDef(schema: unknown): ZodDef | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const z = schema as ZodLike;
  return z._zod?.def ?? z._def;
}

function getType(def: ZodDef | undefined): string | undefined {
  return def?.type ?? def?.typeName;
}

const WRAPPER_TYPES = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'lazy',
  'readonly',
  'pipe',
  'effects',
  'preprocess',
  'transform',
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodCatch',
  'ZodLazy',
  'ZodReadonly',
  'ZodPipeline',
  'ZodEffects',
  'ZodBranded',
]);

function unwrapInnerType(schema: unknown): unknown {
  let current: unknown = schema;
  let safety = 0;
  while (current && safety++ < 32) {
    const def = getDef(current);
    if (!def) break;
    const t = getType(def);
    if (!t || !WRAPPER_TYPES.has(t)) break;
    const next = (def.innerType ?? def.in ?? def.schema ?? def.getter?.()) as unknown | undefined;
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function getShape(schema: unknown): Record<string, unknown> | null {
  const direct = (schema as ZodLike)?.shape;
  if (direct && typeof direct === 'object') return direct;
  const def = getDef(schema);
  if (!def) return null;
  const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
  return shape && typeof shape === 'object' ? shape : null;
}

function descendIntoSchema(schema: unknown, key: PropertyKey): unknown {
  const s = unwrapInnerType(schema);
  const def = getDef(s);
  if (!def) return undefined;
  const t = getType(def);

  if (t === 'object' || t === 'ZodObject') {
    const shape = getShape(s);
    if (shape) return shape[String(key)];
    return undefined;
  }

  if ((t === 'array' || t === 'ZodArray') && typeof key === 'number') {
    return def.element ?? (s as ZodLike)?.element;
  }

  if (
    t === 'union' ||
    t === 'discriminatedUnion' ||
    t === 'ZodUnion' ||
    t === 'ZodDiscriminatedUnion'
  ) {
    const options = def.options ?? (s as ZodLike)?.options;
    if (Array.isArray(options)) {
      for (const opt of options) {
        const result = descendIntoSchema(opt, key);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }

  if (t === 'intersection' || t === 'ZodIntersection') {
    return descendIntoSchema(def.left, key) ?? descendIntoSchema(def.right, key);
  }

  return undefined;
}

function getObjectShapeKeys(schema: unknown): string[] | null {
  const s = unwrapInnerType(schema);
  const def = getDef(s);
  if (!def) return null;
  const t = getType(def);

  if (t === 'object' || t === 'ZodObject') {
    const shape = getShape(s);
    return shape ? Object.keys(shape) : null;
  }

  if (t === 'intersection' || t === 'ZodIntersection') {
    const left = getObjectShapeKeys(def.left);
    const right = getObjectShapeKeys(def.right);
    if (left || right) {
      return Array.from(new Set([...(left ?? []), ...(right ?? [])]));
    }
  }

  return null;
}

function walkSchema(schema: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = schema;
  for (const segment of path) {
    if (current === undefined) return undefined;
    current = descendIntoSchema(current, segment);
  }
  return current;
}

function getAcceptedKeysAt(schema: unknown, path: readonly PropertyKey[]): string[] | null {
  const target = walkSchema(schema, path);
  if (target === undefined) return null;
  return getObjectShapeKeys(target);
}

function getDiscriminatorOptionsAt(
  schema: unknown,
  path: readonly PropertyKey[],
  discriminator: string | undefined
): string[] | null {
  if (!discriminator) return null;
  const target = walkSchema(schema, path);
  if (target === undefined) return null;
  const s = unwrapInnerType(target);
  const def = getDef(s);
  if (!def) return null;
  const t = getType(def);
  if (
    t !== 'union' &&
    t !== 'discriminatedUnion' &&
    t !== 'ZodUnion' &&
    t !== 'ZodDiscriminatedUnion'
  ) {
    return null;
  }
  const options = def.options ?? (s as ZodLike)?.options;
  if (!Array.isArray(options)) return null;
  const values: string[] = [];
  for (const opt of options) {
    const inner = unwrapInnerType(opt);
    const innerDef = getDef(inner);
    const innerType = getType(innerDef);
    if (innerType !== 'object' && innerType !== 'ZodObject') continue;
    const shape = getShape(inner);
    if (!shape) continue;
    const fieldSchema = shape[discriminator];
    const fieldUnwrapped = unwrapInnerType(fieldSchema);
    const fieldDef = getDef(fieldUnwrapped);
    const fieldType = getType(fieldDef);
    if (fieldType === 'literal' || fieldType === 'ZodLiteral') {
      const literalValues =
        fieldDef?.values ?? (fieldDef?.value !== undefined ? [fieldDef.value] : []);
      for (const v of literalValues) {
        if (v !== undefined) values.push(formatPrimitive(v));
      }
    } else if (fieldType === 'enum' || fieldType === 'ZodEnum') {
      const enumValues = fieldDef?.entries
        ? Object.values(fieldDef.entries)
        : (fieldDef?.values ?? []);
      for (const v of enumValues) {
        if (v !== undefined) values.push(formatPrimitive(v));
      }
    }
  }
  return values.length > 0 ? Array.from(new Set(values)) : null;
}

/**
 * `z.union(...)` and `z.discriminatedUnion(...)` produce `invalid_union`
 * issues whose `errors` array holds the failures for every variant the
 * value didn't match. Surfacing the raw outer message ("Invalid input")
 * is useless — the actionable information is one level down, inside the
 * variant the user was actually trying to use.
 *
 * Pick the variant the user was *closest* to and recurse into its issues,
 * prefixing each inner path with the union's own path. Scoring rules:
 *
 *   - Discriminator literal mismatch (depth-1 `invalid_value`): disqualify.
 *     The user picked a different arm of the union.
 *   - "No matching discriminator" inner union with empty `errors`: disqualify.
 *     This variant rejected the user's discriminator wholesale.
 *   - Root `invalid_type` expecting a primitive (string, number, etc.):
 *     disqualify. The variant wanted a totally different shape than what
 *     the user wrote (e.g. a placeholder string instead of an object).
 *   - Among remaining variants, prefer ones with deeper issue paths — those
 *     are arms whose structure matched and whose inner fields are wrong.
 *
 * When no variant scores positively, fall back to the variant with the
 * fewest issues so the formatter still surfaces something actionable.
 */
// Per-variant `.refine((v) => v.type === '<discriminator>', { path: ['type'] })`
// checks fail on every sibling variant whose discriminator value differs from
// what the user wrote. Those refines are the schema author's way of saying
// "this isn't the variant you meant" — surfacing the failure as a closest-
// match candidate would push the formatter into the wrong arm of the union.
// Any depth-1 `custom` issue at `path: ['type']` is, by construction, a
// discriminator refine, so we treat it as a wrong-variant marker regardless
// of the human message text. Keeping this signal structural (rather than
// regex-matching the message) avoids coupling the protocol package to the
// wording chosen in any particular schema.
function isWrongVariantTypeRefine(issue: ZodIssue): boolean {
  return issue.code === 'custom' && issue.path.length === 1 && issue.path[0] === 'type';
}

function variantMatchScore(variant: ZodIssue[]): number {
  if (variant.length === 0) return 0;
  for (const issue of variant) {
    if (issue.code === 'invalid_value' && issue.path.length === 1) {
      return 0;
    }
    if (isWrongVariantTypeRefine(issue)) {
      return 0;
    }
  }
  if (variant.length === 1) {
    const sole = variant[0]!;
    if (
      sole.code === 'invalid_union' &&
      Array.isArray((sole as { errors?: unknown[] }).errors) &&
      ((sole as { errors?: unknown[] }).errors as unknown[]).length === 0
    ) {
      return 0;
    }
    if (
      sole.code === 'invalid_type' &&
      sole.path.length === 0 &&
      (sole as { expected?: string }).expected !== undefined &&
      (sole as { expected?: string }).expected !== 'object'
    ) {
      return 0;
    }
  }
  let score = 1;
  for (const issue of variant) {
    score += issue.path.length;
  }
  return score;
}

// A variant that rejects keys at its own root does not describe the object the
// user wrote. When another variant accepts every root key, prefer that one even
// if this variant reports more (and deeper) issues.
function hasRootUnrecognizedKeys(variant: ZodIssue[]): boolean {
  return variant.some((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0);
}

function pickClosestUnionVariant(variants: ZodIssue[][]): ZodIssue[] | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  let best: ZodIssue[] | null = null;
  let bestScore = 0;
  const someVariantAcceptsRootKeys = variants.some(
    (variant) => Array.isArray(variant) && variant.length > 0 && !hasRootUnrecognizedKeys(variant)
  );

  for (const variant of variants) {
    if (!Array.isArray(variant)) continue;
    if (someVariantAcceptsRootKeys && hasRootUnrecognizedKeys(variant)) continue;
    const score = variantMatchScore(variant);
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }

  if (best) return best;

  // No variant looks closer than another. Fall back to the smallest
  // non-empty variant so we surface *something* instead of swallowing
  // detail.
  let fallback: ZodIssue[] | null = null;
  for (const variant of variants) {
    if (Array.isArray(variant) && variant.length > 0) {
      if (fallback === null || variant.length < fallback.length) {
        fallback = variant;
      }
    }
  }
  return fallback;
}

function formatIssue(issue: ZodIssue, indent: string, schema: unknown | undefined): string[] {
  const code = issue.code;
  const message = issue.message;

  // Unrecognized keys produce one bullet per offending key with the key
  // appended to the parent path so authors see `load.integration:` rather
  // than the parent-only `load:`.
  if (code === 'unrecognized_keys') {
    const keys = (issue as { keys?: string[] }).keys ?? [];
    if (keys.length > 0) {
      const accepted = schema ? getAcceptedKeysAt(schema, issue.path) : null;
      return keys.map((key) => {
        const fullPath = buildPath([...issue.path, key]);
        const details: string[] = ['code: unrecognized_keys'];
        if (accepted && accepted.length > 0) {
          details.push(`accepted: ${JSON.stringify(accepted)}`);
        }
        return `${indent}- ${fullPath}: Unrecognized key (${details.join('; ')})`;
      });
    }
  }

  if (code === 'invalid_union') {
    const errors = (issue as { errors?: ZodIssue[][] }).errors;
    const discriminator = (issue as { discriminator?: string }).discriminator;

    // When the union carries nested per-variant errors, expand into the
    // closest-matching variant. Without this, the user sees only
    // "transports.0: Invalid input" with no field-level detail.
    if (Array.isArray(errors) && errors.length > 0) {
      const variant = pickClosestUnionVariant(errors);
      if (variant && variant.length > 0) {
        return variant.flatMap((inner) =>
          formatIssue(
            {
              ...inner,
              path: [...issue.path, ...inner.path],
            } as ZodIssue,
            indent,
            schema
          )
        );
      }
    }

    // No nested errors (or all variants discriminator-mismatched). Emit the
    // outer union bullet so the user still sees *something*.
    const pathStr = buildPath(issue.path);
    const detailParts: string[] = ['code: invalid_union'];
    if (discriminator) {
      detailParts.push(`discriminator: ${discriminator}`);
      const last = issue.path[issue.path.length - 1];
      const unionPath =
        last !== undefined && String(last) === discriminator ? issue.path.slice(0, -1) : issue.path;
      const accepted = schema ? getDiscriminatorOptionsAt(schema, unionPath, discriminator) : null;
      if (accepted && accepted.length > 0) {
        detailParts.push(`accepted: [${accepted.join(', ')}]`);
      }
    }
    return [`${indent}- ${pathStr}: ${message} (${detailParts.join('; ')})`];
  }

  const pathStr = buildPath(issue.path);
  const detailParts: string[] = [`code: ${code}`];

  if (code === 'invalid_type') {
    const expected = (issue as { expected?: unknown }).expected;
    const got = describeReceived(issue);
    if (expected !== undefined) detailParts.push(`expected: ${String(expected)}`);
    if (got !== null) detailParts.push(`got: ${got}`);
  } else if (code === 'invalid_value') {
    const values = (issue as { values?: unknown[] }).values;
    if (Array.isArray(values) && values.length > 0) {
      detailParts.push(`accepted: ${JSON.stringify(values)}`);
    }
  } else if (code === 'too_big') {
    const maximum = (issue as { maximum?: number | bigint }).maximum;
    if (maximum !== undefined) detailParts.push(`maximum: ${String(maximum)}`);
  } else if (code === 'too_small') {
    const minimum = (issue as { minimum?: number | bigint }).minimum;
    if (minimum !== undefined) detailParts.push(`minimum: ${String(minimum)}`);
  } else if (code === 'invalid_format') {
    const format = (issue as { format?: string }).format;
    if (format) detailParts.push(`format: ${format}`);
  }

  return [`${indent}- ${pathStr}: ${message} (${detailParts.join('; ')})`];
}

/**
 * Format a Zod error as a bullet list of per-issue lines. Each line names
 * the offending field, the failure message, and the issue code plus any
 * code-specific detail (expected type, accepted values, discriminator).
 */
export function formatZodIssues(error: ZodError, options: FormatSpecErrorOptions = {}): string {
  const indent = options.indent ?? '  ';
  return error.issues.flatMap((issue) => formatIssue(issue, indent, options.schema)).join('\n');
}

/**
 * Build the full `Invalid <kind> spec at <path>\n<issues>` message for
 * spec-validation failures. Use `reportSpecValidationError` when you want
 * an `Error` instance ready to throw.
 */
export function formatSpecValidationMessage(
  kind: SpecValidationKind,
  filePath: string,
  error: ZodError,
  options: FormatSpecErrorOptions = {}
): string {
  const body = formatZodIssues(error, options);
  const hint = options.hint ? `\n${options.hint}` : '';
  return `Invalid ${kind} spec at ${filePath}\n${body}${hint}`;
}

/**
 * Build a ready-to-throw `Error` for a failed `safeParse` result. Replace
 * the bare `throw new Error('Invalid X spec ' + path)` pattern at every
 * call site so downstream agents and humans get per-field detail.
 *
 * Callers that need an `exitCode` (i.e. need `CommandError`) should pass
 * `.message` into `new CommandError(...)`, since `CommandError` is also
 * exported from `@bobsled-inc/protocol`.
 */
export function reportSpecValidationError(
  kind: SpecValidationKind,
  filePath: string,
  error: ZodError,
  options: FormatSpecErrorOptions = {}
): Error {
  return new Error(formatSpecValidationMessage(kind, filePath, error, options));
}
