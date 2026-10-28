import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse as parseYaml, stringify } from 'yaml';
import { CommandError } from '../errors.js';
import { boundedJson } from './storage.js';

export const OSSIE_VENDOR = 'DOGSLED';
export interface ConversionObjectReference {
  documentPath: string;
  dataset?: string;
  field?: string;
  targetPath?: string;
}
export interface ConversionDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  objectReference: ConversionObjectReference;
  message: string;
  remedy: string;
}
export interface ConversionFile {
  path: string;
  content: string;
  document: Record<string, unknown>;
}
export interface ConversionResult {
  ok: boolean;
  ready: boolean;
  files: ConversionFile[];
  diagnostics: ConversionDiagnostic[];
}
export const recordSchema = z.record(z.string(), z.unknown());
export function record(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value);
}
export function omit(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
export function identity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
export function file(path: string, document: Record<string, unknown>): ConversionFile {
  return { path, document, content: stringify(document, { lineWidth: 0 }) };
}
export function parseInterchangeInput(content: string, path: string): unknown {
  if (Buffer.byteLength(content, 'utf8') > 1_000_000) {
    throw new CommandError(`${path}: Input exceeds 1 MB`, 2);
  }
  const value: unknown = path.endsWith('.json')
    ? JSON.parse(content)
    : parseYaml(content, { maxAliasCount: 0 });
  assertBounded(value);
  return value;
}
export function parseOssieYaml(content: string, path: string): unknown {
  if (Buffer.byteLength(content, 'utf8') > 1_000_000) {
    throw new CommandError(`${path}: Input exceeds 1 MB`, 2);
  }
  const value: unknown = parseYaml(content, { maxAliasCount: 0 });
  assertBounded(value);
  return value;
}
export function assertBounded(value: unknown): void {
  if (!boundedJson(value)) {
    throw new CommandError(
      'Input must be bounded JSON data, without cycles or unsafe property keys',
      2
    );
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function diagnostic(
  code: string,
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
  objectReference: ConversionObjectReference = { documentPath: path.split('#')[0] ?? path },
  remedy = 'Review the diagnostic and update the input before converting again.'
): ConversionDiagnostic {
  return { code, severity, path, objectReference, message, remedy };
}
export function extensions(
  metadata: Record<string, unknown>
): { vendor_name: string; data: string }[] {
  return z
    .array(z.object({ vendor_name: z.string(), data: z.string() }))
    .parse(metadata['custom_extensions'] ?? []);
}
export function foreignMetadata(
  value: Record<string, unknown>,
  mapped: readonly string[]
): Record<string, unknown> {
  const result = omit(value, [...mapped, 'custom_extensions']);
  const foreign = extensions(value).filter((e) => e.vendor_name !== OSSIE_VENDOR);
  if (foreign.length) result['custom_extensions'] = foreign;
  return result;
}
