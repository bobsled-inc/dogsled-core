/**
 * Minimal output-format primitives shared across all `@bobsled-inc/*`
 * packages. Both sdk-codegen and entity-graph (leaf packages with no
 * dependency on `@bobsled-inc/bobsled-core`) route their CLI output through
 * these helpers so they never call `process.stdout.write` /
 * `process.stderr.write` directly. This preserves dependency layering:
 * Bobsled Core depends on protocol, never the reverse.
 *
 * Bobsled Core's full `lib/output/formatter.ts` (chalk-aware human formatting,
 * spinner control, table rendering) layers on top of these primitives.
 */

export type OutputFormat = 'json' | 'yaml' | 'human';

/**
 * Stream-injection seam. Production code uses `defaultWriter()`;
 * tests substitute a capturing implementation so unit tests assert on
 * exact emitted bytes. The same shape works for both stdout and stderr
 * — callers pick which fields to use.
 */
export interface Writer {
  out(s: string): void;
  err(s: string): void;
}

export function defaultWriter(): Writer {
  return {
    out: (s: string) => {
      process.stdout.write(s);
    },
    err: (s: string) => {
      process.stderr.write(s);
    },
  };
}

export interface ResolveFormatOptions {
  /** Explicit `--json` flag from the caller. */
  json?: boolean;
  /** Explicit `--yaml` flag from the caller. */
  yaml?: boolean;
  /** Environment variables (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Whether stdout is a TTY (defaults to `process.stdout.isTTY`). */
  isTTY?: boolean;
}

/**
 * Resolve the CLI output format with the documented priority cascade:
 *  1. Explicit `--json` / `--yaml` flag.
 *  2. `BOBSLED_CORE_OUTPUT_FORMAT` env var (`json` / `yaml` / `text` / `human`).
 *  3. `CI=1` / `CI=true` env var → JSON (auto-detect for CI runners).
 *  4. Non-TTY stdout → JSON.
 *  5. Default: `human`.
 */
export function resolveOutputFormat(opts: ResolveFormatOptions = {}): OutputFormat {
  if (opts.json) return 'json';
  if (opts.yaml) return 'yaml';
  const env = opts.env ?? process.env;
  const envFormat = env['BOBSLED_CORE_OUTPUT_FORMAT']?.toLowerCase();
  if (envFormat === 'json') return 'json';
  if (envFormat === 'yaml') return 'yaml';
  if (envFormat === 'text' || envFormat === 'human') return 'human';
  if (env['CI'] === '1' || env['CI'] === 'true') return 'json';
  const tty = opts.isTTY ?? process.stdout.isTTY;
  if (!tty) return 'json';
  return 'human';
}

/**
 * Minimal canonical-shape YAML emitter for command-result payloads.
 * Handles primitives, arrays, and plain objects. Intentionally does NOT
 * support refs, anchors, multi-document streams, or custom tags — those
 * aren't needed for command-result envelopes and would add a real YAML
 * dependency to a package that explicitly wants to stay light.
 */
export function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return `${pad}null`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    // Multi-line children (nested arrays/objects) need their continuation
    // lines re-indented under the leading "- " marker. The previous
    // `.trimStart()` collapsed every child line to the parent's pad and
    // lost two-space depth. Render each
    // child once at the next depth, then walk the lines: first becomes
    // "<pad>- <first>", rest get the child indentation preserved.
    const childPad = '  '.repeat(indent + 1);
    return value
      .map((v) => {
        const rendered = toYaml(v, indent + 1).split('\n');
        const firstLine = (rendered[0] ?? '').slice(childPad.length);
        const rest = rendered.slice(1);
        if (rest.length === 0) return `${pad}- ${firstLine}`;
        return [`${pad}- ${firstLine}`, ...rest].join('\n');
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        if (v && typeof v === 'object') {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`;
      })
      .join('\n');
  }
  return `${pad}${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
}

/**
 * Emit a structured payload through the writer in the chosen format.
 * `human` callers must supply a `humanRender` callback — there's no
 * useful default for arbitrary command-result shapes.
 */
export function emitPayload(
  payload: unknown,
  format: OutputFormat,
  writer: Writer,
  humanRender?: () => string
): void {
  if (format === 'json') {
    writer.out(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  if (format === 'yaml') {
    writer.out(toYaml(payload) + '\n');
    return;
  }
  if (humanRender) {
    writer.out(humanRender() + '\n');
  } else {
    writer.out(JSON.stringify(payload) + '\n');
  }
}

/**
 * Emit an error message through the writer. JSON / YAML modes serialize
 * a stable `{ ok: false, error: <message> }` envelope so machine
 * consumers can rely on the shape. Human mode writes a plain
 * `error: <message>` to stderr.
 */
export function emitError(message: string, format: OutputFormat, writer: Writer): void {
  if (format === 'json') {
    writer.err(JSON.stringify({ ok: false, error: message }) + '\n');
    return;
  }
  if (format === 'yaml') {
    writer.err(toYaml({ ok: false, error: message }) + '\n');
    return;
  }
  writer.err(`error: ${message}\n`);
}
