/**
 * Output formatter that switches between human-readable text and
 * machine-readable JSON based on the --json flag.
 *
 * All CLI output MUST go through these functions so that:
 *   - Structured tools (CI, scripts) can reliably parse JSON output.
 *   - Humans get colourful, readable text in the terminal.
 *   - --quiet and --verbose are respected consistently.
 */

import chalk, { Chalk } from 'chalk';

import type { GlobalOptions, OutputOptions } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Output options factory
// ---------------------------------------------------------------------------

/** Extract OutputOptions from GlobalOptions. Eliminates per-handler duplication. */
export function toOutputOptions(globalOptions: GlobalOptions): OutputOptions {
  return {
    json: globalOptions.json,
    quiet: globalOptions.quiet,
    verbose: globalOptions.verbose,
    noColor: globalOptions.noColor,
  };
}

// ---------------------------------------------------------------------------
// Chalk instance that respects --no-color and NO_COLOR env
// ---------------------------------------------------------------------------

/** A chalk-like instance with colour methods (green, red, blue, etc.). */
type ChalkLike = typeof chalk;

function createChalk(options: OutputOptions): ChalkLike {
  if (options.noColor || process.env['NO_COLOR'] !== undefined) {
    return new Chalk({ level: 0 });
  }
  return chalk;
}

// ---------------------------------------------------------------------------
// Core output
// ---------------------------------------------------------------------------

/**
 * Print structured data.
 * - In JSON mode: serialises `data` as a single JSON line.
 * - In text mode: prints `data` via its `toString()` / default formatting.
 */
export function output(data: unknown, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    process.stdout.write(String(data) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Semantic helpers
// ---------------------------------------------------------------------------

/**
 * Report success.
 * - Text mode: green check mark followed by message.
 * - JSON mode: `{ "ok": true, "message": "..." }`.
 */
export function success(message: string, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, message }) + '\n');
  } else {
    const c = createChalk(options);
    process.stdout.write(c.green('✓') + ' ' + message + '\n');
  }
}

/**
 * Report an error.
 * - Text mode: red X followed by message (written to stderr).
 * - JSON mode: `{ "ok": false, "error": "..." }` (written to stdout for parseability).
 */
export function error(message: string, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  } else {
    const c = createChalk(options);
    process.stderr.write(c.red('✗') + ' ' + message + '\n');
  }
}

/**
 * Print informational messages. Suppressed in --quiet mode.
 */
export function info(message: string, options: OutputOptions): void {
  if (options.quiet) return;

  if (options.json) {
    // In JSON mode, info messages are emitted as structured objects on stdout
    // so that consumers can filter by "level".
    process.stdout.write(JSON.stringify({ level: 'info', message }) + '\n');
  } else {
    const c = createChalk(options);
    process.stdout.write(c.blue('ℹ') + ' ' + message + '\n');
  }
}

/**
 * Print warning messages. Suppressed in --quiet mode.
 */
export function warn(message: string, options: OutputOptions): void {
  if (options.quiet) return;

  if (options.json) {
    process.stdout.write(JSON.stringify({ level: 'warn', message }) + '\n');
  } else {
    const c = createChalk(options);
    process.stderr.write(c.yellow('⚠') + ' ' + message + '\n');
  }
}

/**
 * Print debug messages. Only visible in --verbose mode.
 */
export function debug(message: string, options: OutputOptions): void {
  if (!options.verbose) return;

  if (options.json) {
    process.stdout.write(JSON.stringify({ level: 'debug', message }) + '\n');
  } else {
    const c = createChalk(options);
    process.stderr.write(c.gray('[debug] ' + message) + '\n');
  }
}

// ---------------------------------------------------------------------------
// CRUD command helpers
//
// Structured envelopes for resource CRUD commands. In JSON mode they emit
// a consistent `{ok, data}` / `{ok, error}` shape. In text mode they
// delegate to the regular success/error helpers.
// ---------------------------------------------------------------------------

/**
 * Emit a successful CRUD result.
 * - JSON mode: `{ "ok": true, "data": ... }`
 * - Text mode: green check mark with a summary of `data`.
 */
export function crudSuccess(data: unknown, options: OutputOptions): void {
  if (options.quiet) return;

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  } else {
    const c = createChalk(options);
    const text =
      data !== null && typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    process.stdout.write(c.green('✓') + ' ' + text + '\n');
  }
}

// ---------------------------------------------------------------------------
// Debug logger factory (for passing to API client)
// ---------------------------------------------------------------------------

/**
 * Create a debug log callback suitable for passing to DogsledClientOptions.
 * Returns a no-op when verbose is off.
 */
export function createDebugLogger(options: OutputOptions): ((message: string) => void) | undefined {
  if (!options.verbose) return undefined;
  const c = createChalk(options);
  return (message: string) => {
    process.stderr.write(c.gray('[debug] ' + message) + '\n');
  };
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

/**
 * Render tabular data.
 * - JSON mode: emits an array of objects keyed by headers.
 * - Text mode: simple fixed-width column layout.
 */
export function table(headers: string[], rows: string[][], options: OutputOptions): void {
  if (options.json) {
    const objects = rows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] ?? '';
      });
      return obj;
    });
    process.stdout.write(JSON.stringify(objects) + '\n');
    return;
  }

  // Compute column widths (minimum = header length)
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      const cell = row[i] ?? '';
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }

  const c = createChalk(options);

  // Header row
  const headerLine = headers.map((h, i) => c.bold(h.padEnd(widths[i] ?? 0))).join('  ');
  process.stdout.write(headerLine + '\n');

  // Separator
  const separator = widths.map((w) => '─'.repeat(w)).join('──');
  process.stdout.write(c.gray(separator) + '\n');

  // Data rows
  for (const row of rows) {
    const line = headers.map((_h, i) => (row[i] ?? '').padEnd(widths[i] ?? 0)).join('  ');
    process.stdout.write(line + '\n');
  }
}
