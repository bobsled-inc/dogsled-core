/**
 * `bobsled sdk generate` CLI.
 *
 * Reads the entity-graph IR from disk via `readIr()`, then emits TypeScript
 * SDK files. Python emitter retained as a library export (skip per user
 * instruction — TS-only CLI v1).
 *
 * Flags: --lang ts, --out <dir>, --ir-only, --json, --yaml, --verbose,
 * --quiet. All output flows through `@bobsled-inc/protocol` shared
 * formatter primitives — CLI never calls `process.stdout.write` /
 * `process.stderr.write` directly. Tests inject a `Writer` instead of
 * patching the global stream.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { Command } from 'commander';
import {
  CommandError,
  defaultWriter,
  emitError,
  emitPayload,
  resolveOutputFormat,
  type OutputFormat,
  type Writer,
} from '@bobsled-inc/protocol';
import { ZodError } from 'zod';

import { readIr } from '../ir/reader.js';
import { emitTypeScriptSdk } from '../emitters/typescript/index.js';
import type { EmittedFile } from '../emitters/typescript/index.js';

export interface SdkGenerateOptions {
  /**
   * Test seam — defaults to `defaultWriter()`. Implementations can
   * capture stdout / stderr separately for assertion. The legacy
   * `write?: (s: string) => void` shape is still accepted for backward
   * compatibility and routes everything through `out`.
   */
  writer?: Writer;
  /** @deprecated Use `writer` instead. Retained for in-flight callers. */
  write?: (output: string) => void;
}

function resolveWriter(options: SdkGenerateOptions): Writer {
  if (options.writer) return options.writer;
  if (options.write) {
    const w = options.write;
    return {
      out: (s) => w(s),
      err: (s) => w(s),
    };
  }
  return defaultWriter();
}

export interface SdkGenerateInvocation {
  cwd?: string;
  lang: string;
  out?: string;
  irOnly?: boolean;
  integration?: string;
  json?: boolean;
  yaml?: boolean;
  /** Suppress non-error output (per AGENTS.md). */
  quiet?: boolean;
  /** Emit per-file detail (per AGENTS.md). */
  verbose?: boolean;
}

export interface SdkGenerateResult {
  ok: boolean;
  ir_version: string;
  entity_count: number;
  files_written: number;
  manifest: { path: string; bytes: number }[];
  /**
   * Non-fatal warnings collected during IR projection (e.g. relationships
   * skipped because their endpoints were not declared as entity types).
   * Empty when projection produced no warnings.
   */
  warnings: string[];
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function resolveOutputPath(outDir: string, filePath: string): string {
  const target = resolve(outDir, filePath);
  const rel = relative(outDir, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CommandError(`Refusing to write outside output directory: '${filePath}'`, 2);
  }
  return target;
}

function humanResult(payload: SdkGenerateResult, verbose: boolean | undefined): string {
  const head = `Generated ${payload.files_written} TypeScript file(s) from ${payload.entity_count} entity type(s).`;
  const warningsBlock =
    payload.warnings.length === 0
      ? ''
      : '\n' + payload.warnings.map((w) => `  warning: ${w}`).join('\n');
  if (!verbose) return head + warningsBlock;
  const lines = [head, ...payload.manifest.map((f) => `  ${f.path} (${f.bytes} B)`)];
  return lines.join('\n') + warningsBlock;
}

function emitResult(
  payload: SdkGenerateResult,
  format: OutputFormat,
  writer: Writer,
  invocation: { quiet?: boolean; verbose?: boolean }
): void {
  // --quiet suppresses success output entirely (errors still reach
  // stderr); --verbose adds per-file detail in human mode.
  if (invocation.quiet) return;
  emitPayload(payload, format, writer, () => humanResult(payload, invocation.verbose));
}

export async function runSdkGenerate(
  invocation: SdkGenerateInvocation,
  options: SdkGenerateOptions = {}
): Promise<SdkGenerateResult> {
  const writer = resolveWriter(options);

  if (invocation.lang !== 'ts') {
    throw new CommandError(
      `--lang ${String(invocation.lang)} is not supported in v1. Only --lang ts is shipped today; ` +
        `Python emitter is available as a library export but not wired into the CLI per user direction.`,
      2
    );
  }

  const { ir, warnings } = await readIr({
    cwd: invocation.cwd,
    integration: invocation.integration,
  });

  if (invocation.irOnly) {
    const result: SdkGenerateResult = {
      ok: true,
      ir_version: ir.ir_version,
      entity_count: ir.entities.length,
      files_written: 0,
      manifest: [],
      warnings,
    };
    const format = resolveOutputFormat(invocation);
    emitResult(result, format, writer, {
      quiet: invocation.quiet,
      verbose: invocation.verbose,
    });
    return result;
  }

  const outDir = resolve(invocation.cwd ?? process.cwd(), invocation.out ?? './generated');
  const files: EmittedFile[] = emitTypeScriptSdk(ir);

  const manifest: SdkGenerateResult['manifest'] = [];
  for (const f of files) {
    const target = resolveOutputPath(outDir, f.path);
    try {
      ensureDir(dirname(target));
      writeFileSync(target, f.content);
    } catch (err) {
      // FS errors (permission denied, disk full, invalid path) bypass the
      // CommandError catch and surface as raw stack traces. Wrap them with
      // the offending path + original message so the CLI emits a clean
      // exit-code-1.
      const message = err instanceof Error ? err.message : String(err);
      throw new CommandError(`Failed to write SDK file '${f.path}': ${message}`, 1);
    }
    manifest.push({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8') });
  }

  const result: SdkGenerateResult = {
    ok: true,
    ir_version: ir.ir_version,
    entity_count: ir.entities.length,
    files_written: files.length,
    manifest,
    warnings,
  };
  const format = resolveOutputFormat(invocation);
  emitResult(result, format, writer, { quiet: invocation.quiet, verbose: invocation.verbose });
  return result;
}

export function createSdkGenerateCommand(options: SdkGenerateOptions = {}): Command {
  return new Command('generate')
    .description('Generate a typed TypeScript SDK from the project entity graph')
    .option('--lang <lang>', 'SDK language: ts (Python emitter available as library)', 'ts')
    .option('--out <dir>', 'Output directory', './generated')
    .option('--integration <handle>', 'Limit to one integration handle')
    .option('--ir-only', 'Emit IR validation result only; skip file writes', false)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--yaml', 'Machine-readable YAML output', false)
    .option('--verbose', 'Verbose logging', false)
    .option('--quiet', 'Suppress non-error output', false)
    .action(
      async (opts: {
        lang: string;
        out: string;
        integration?: string;
        irOnly: boolean;
        json: boolean;
        yaml: boolean;
        verbose: boolean;
        quiet: boolean;
      }) => {
        const writer = resolveWriter(options);
        try {
          await runSdkGenerate(
            {
              // SdkGenerateInvocation.lang is `string`; pass through directly
              // — runSdkGenerate validates supported values and throws
              // CommandError(2) on rejection.
              lang: opts.lang,
              out: opts.out,
              integration: opts.integration,
              irOnly: opts.irOnly,
              json: opts.json,
              yaml: opts.yaml,
              verbose: opts.verbose,
              quiet: opts.quiet,
            },
            options
          );
        } catch (err) {
          const format = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, format, writer);
            return;
          }
          // ZodError from readIr() is user-facing IR validation; surface
          // a clean exit-code-2 with field-by-field issues rather than a
          // raw stack trace.
          if (err instanceof ZodError) {
            process.exitCode = 2;
            const issues = err.issues
              .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
              .join('\n');
            emitError(`SDK IR validation failed:\n${issues}`, format, writer);
            return;
          }
          // Anything else (FS, pinned-TS install, Node SDK, etc.) is an
          // unexpected runtime failure — normalize to exit 1 + a clean
          // error envelope instead of rethrowing a raw stack trace
          //.
          process.exitCode = 1;
          const message = err instanceof Error ? err.message : String(err);
          emitError(`Unexpected error during SDK generation: ${message}`, format, writer);
          return;
        }
      }
    );
}

export function registerSdkCommand(parent: Command, options: SdkGenerateOptions = {}): void {
  const sdk = parent
    .command('sdk')
    .description('Generate a typed SDK for the project entity graph');
  sdk.addCommand(createSdkGenerateCommand(options));
}
