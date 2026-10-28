/**
 * Verified Query (VQ) spec — an NL-question-to-SQL pairing that downstream
 * agents can treat as ground truth.
 *
 * Shape mirrors the Notion sub-spec (`verified queries` section) and the
 * host application's `verified_queries` table so host applications can consume both.
 *
 * The SQL field supports `{ref}` tokens (either `{model_name}` or
 * `{connection.source_name}`) which are replaced with qualified identifiers
 * at query time. Cross-reference validation — checking that every token
 * resolves to a real Model Spec model or source — lives in
 * `src/entities/cross-references.ts`.
 */

import { z } from 'zod';

import { MODEL_SPEC_ERROR_CODES, modelSpecHint } from '../compiler/error-hints.js';
import { identifierMsg, identifierRegex } from '../compiler/shared-validators.js';

/** Runtime-bound parameter. `type` is advisory; callers decide the coercion. */
export const VqParameterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Parameter name is required')
      .regex(identifierRegex, identifierMsg),
    type: z.enum(['string', 'integer', 'number', 'boolean', 'timestamp', 'date']),
    description: z.string().optional(),
    required: z.boolean().default(true),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();
export type VqParameter = z.infer<typeof VqParameterSchema>;

export const VqSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('vq', {
      error: (issue) => {
        if (issue.input === 'verified_query') {
          return modelSpecHint(
            MODEL_SPEC_ERROR_CODES.VQ_TYPE_LITERAL_MISMATCH,
            `Use type: vq (the human-readable kind is "verified query", but the file literal is 'vq').`
          );
        }
        return undefined;
      },
    }),
    name: z.string().trim().min(1, 'VQ name is required').regex(identifierRegex, identifierMsg),
    description: z.string().optional(),

    /**
     * Natural-language question the SQL answers. Used by agents for NL → VQ
     * retrieval; short (~one sentence) is expected.
     */
    nlq: z.string().trim().min(1, 'Natural-language question is required'),

    /**
     * The query, with `{ref}` tokens for models and `{connection.source}`
     * tokens for raw sources. Validation checks every token resolves.
     */
    sql: z.string().trim().min(1, 'SQL is required'),

    parameters: z.array(VqParameterSchema).optional(),

    /**
     * Optional integration handle — pins the VQ to a specific warehouse when
     * it can't run everywhere. The handle must match a declared integration;
     * unknown handles surface as a cross-reference error.
     */
    connection: z
      .string()
      .trim()
      .min(1, 'Connection handle must be non-empty')
      .regex(identifierRegex, identifierMsg)
      .optional(),

    tags: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export type VqSpec = z.infer<typeof VqSpecSchema>;

// ---------------------------------------------------------------------------
// {ref} token extraction
// ---------------------------------------------------------------------------

/**
 * Single `{ref}` token in VQ SQL. We keep `raw` (the `{a.b}` substring as it
 * appears) so downstream planners can do targeted `.replaceAll` passes when
 * rewriting the SQL, and split `segments` for cross-reference validation.
 */
export interface VqSqlToken {
  raw: string;
  segments: string[];
}

// Match `{name}` or `{connection.name}`.
const VQ_TOKEN_REGEX = /\{([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)\}/g;

/**
 * Strip single-quoted strings, double-quoted identifiers, `--` line comments,
 * and `/* ... *\/` block comments so `{…}` tokens embedded inside them aren't
 * picked up as refs. Preserves length so downstream `.replaceAll` passes on
 * the original SQL still line up with token positions if needed.
 */
function maskSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < sql.length) {
        const c = sql[i]!;
        // SQL escapes a quote by doubling it; skip the pair without closing.
        if (c === quote && sql[i + 1] === quote) {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === quote) {
          out += ' ';
          i += 1;
          break;
        }
        out += ' ';
        i += 1;
      }
      continue;
    }

    // PostgreSQL dollar-quoted strings: $$…$$ or $tag$…$tag$
    if (ch === '$') {
      const opener = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (opener) {
        const tag = opener[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += ' '.repeat(stop - i);
        i = stop;
        continue;
      }
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** Extract every `{ref}` token from a VQ SQL string, in order of appearance. */
export function extractVqSqlTokens(sql: string): VqSqlToken[] {
  const masked = maskSqlLiteralsAndComments(sql);
  const tokens: VqSqlToken[] = [];
  for (const match of masked.matchAll(VQ_TOKEN_REGEX)) {
    tokens.push({ raw: match[0], segments: match[1]!.split('.') });
  }
  return tokens;
}

export function mapVqSqlReferences(sql: string, map: (reference: string) => string): string {
  const masked = maskSqlLiteralsAndComments(sql);
  let output = '';
  let offset = 0;
  for (const match of masked.matchAll(VQ_TOKEN_REGEX)) {
    output += sql.slice(offset, match.index) + `{${map(match[1]!)}}`;
    offset = match.index + match[0].length;
  }
  return output + sql.slice(offset);
}
