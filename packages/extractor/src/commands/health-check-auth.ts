const LEGACY_ENV_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const ENV_TEMPLATE_RE = /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function collectAuthEnvVars(auth: unknown): string[] {
  const envVars = new Set<string>();

  visitValues(auth, envVars);

  return [...envVars];
}

function visitValues(value: unknown, envVars: Set<string>): void {
  if (typeof value === 'string') {
    const legacyMatch = value.match(LEGACY_ENV_RE);
    if (legacyMatch) {
      envVars.add(legacyMatch[1]!);
    }

    for (const match of value.matchAll(ENV_TEMPLATE_RE)) {
      envVars.add(match[1]!);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitValues(item, envVars);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      visitValues(nestedValue, envVars);
    }
  }
}
