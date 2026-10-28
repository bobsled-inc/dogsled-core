export const SIMPLE_ENV_PLACEHOLDER_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
export const BRACED_ENV_PLACEHOLDER_RE = /^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

export function parseEnvPlaceholder(value: string): string | null {
  const simpleMatch = SIMPLE_ENV_PLACEHOLDER_RE.exec(value);
  if (simpleMatch) return simpleMatch[1]!;

  const bracedMatch = BRACED_ENV_PLACEHOLDER_RE.exec(value);
  if (bracedMatch) return bracedMatch[1]!;

  return null;
}
