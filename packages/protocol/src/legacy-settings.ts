import { LEGACY_CORE_SETTING_PREFIX, LEGACY_CORE_SETTINGS } from './legacy-names.js';

/** The prefix of Core's own settings. */
export const CORE_SETTING_PREFIX = 'BOBSLED_CORE_';

const warned = new Set<string>();

/**
 * Old Core settings that are set while their current twin is not, as `[old, current]` pairs.
 * Only presence is checked: the old value is never read.
 */
export function unmatchedLegacySettings(env: NodeJS.ProcessEnv = process.env): [string, string][] {
  return LEGACY_CORE_SETTINGS.map((name): [string, string] => [
    `${LEGACY_CORE_SETTING_PREFIX}${name}`,
    `${CORE_SETTING_PREFIX}${name}`,
  ]).filter(([old, current]) => env[old] !== undefined && env[current] === undefined);
}

/**
 * Warns once per process for each old Core setting that is set without its current twin. Core
 * ignores the old name, so the warning says which name to set instead.
 */
export function warnLegacySettings(
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const [old, current] of unmatchedLegacySettings(env)) {
    if (warned.has(old)) continue;
    warned.add(old);
    warn(`Warning: ${old} is set but ignored; Core reads ${current}. Rename the setting.`);
  }
}
