import { CommandError } from './definitions.js';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate an unquoted SQL identifier, optionally qualified with dots.
 * Callers must use parameter bindings for values rather than this helper.
 */
export function validateSqlIdentifier(value: string, kind: string): string {
  const parts = value.split('.');
  if (parts.length === 0 || parts.some((part) => !IDENTIFIER_RE.test(part))) {
    throw new CommandError(
      `Invalid ${kind} "${value}". Expected a SQL identifier matching ${IDENTIFIER_RE.source}, optionally dot-qualified.`,
      2
    );
  }
  return value;
}

export function isValidSqlIdentifier(value: string): boolean {
  try {
    validateSqlIdentifier(value, 'identifier');
    return true;
  } catch {
    return false;
  }
}
