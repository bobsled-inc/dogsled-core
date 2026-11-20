import { z } from 'zod';
import { CommandError } from './definitions.js';
import { parseEnvPlaceholder } from './env-placeholders.js';

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const AuthEnvVarsSchema = z
  .array(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .refine((name) => !RESERVED_OBJECT_KEYS.has(name), 'Reserved object key')
  )
  .optional();

export function assertDeclaredEnv(name: string, declared: readonly string[] = []): void {
  if (!declared.includes(name)) {
    throw new CommandError(
      `Undeclared environment variable: ${name}. Add ${name} to auth_env_vars.`
    );
  }
}

export function collectEnvironmentReferences(value: unknown): Set<string> {
  const names = new Set<string>();
  function walk(current: unknown): void {
    if (typeof current === 'string') {
      for (const match of current.matchAll(
        /\$\{\{\s*(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
      )) {
        names.add(match[1]!);
      }
      const short = current.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
      if (short) names.add(short[1]!);
    } else if (Array.isArray(current)) {
      current.forEach(walk);
    } else if (current && typeof current === 'object') {
      for (const [key, entry] of Object.entries(current)) {
        // `auth_env_vars` declares names. `object_metadata` is literal text that a copy writes
        // to an object as it is, so a `$NAME` in it is no reference and needs no declaration.
        if (key === 'auth_env_vars' || key === 'object_metadata') continue;
        if (key.endsWith('_env') && typeof entry === 'string') names.add(entry);
        else walk(entry);
      }
    }
  }
  walk(value);
  return names;
}

export function assertDeclaredEnvironmentReferences(
  value: unknown,
  declared: readonly string[] = []
): void {
  for (const name of collectEnvironmentReferences(value)) assertDeclaredEnv(name, declared);
}

export function getEnvironmentDeclarationError(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (
      /^Undeclared (?:API key )?environment variable: ([A-Za-z_][A-Za-z0-9_]*)\. Add \1 to auth_env_vars\.$/.test(
        error.message
      )
    ) {
      return error.message;
    }
    error = error.cause;
  }
  return undefined;
}

export function declaredHostEnvironmentNames(
  names: readonly string[] | undefined,
  env: Record<string, string | undefined> | undefined
): string[] {
  if (names === undefined) return [];
  const parsed = AuthEnvVarsSchema.safeParse(names);
  if (!parsed.success) {
    throw new CommandError('declaredEnvNames must contain valid environment variable names.', 2);
  }
  for (const name of parsed.data!) {
    if (!env || !Object.hasOwn(env, name) || env[name] === undefined) {
      throw new CommandError(
        `Host-declared environment variable ${name} must be supplied in options.env.`,
        2
      );
    }
  }
  return [...new Set(parsed.data!)];
}

export function withDeclaredAuthEnvVars(value: unknown, names: readonly string[]): unknown {
  if (!names.length || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  const declared = AuthEnvVarsSchema.safeParse(config['auth_env_vars']);
  if (!declared.success) return value;
  return { ...config, auth_env_vars: [...new Set([...(declared.data ?? []), ...names])] };
}

/**
 * Declare a model connection's own `api_key` placeholder name in its
 * `auth_env_vars`, for hosts that run models and sign in to providers
 * themselves. The placeholder is unchanged and no value is read.
 */
export function withDeclaredModelApiKey(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const apiKey = (value as Record<string, unknown>)['api_key'];
  const name = typeof apiKey === 'string' ? parseEnvPlaceholder(apiKey) : null;
  return name === null ? value : withDeclaredAuthEnvVars(value, [name]);
}
