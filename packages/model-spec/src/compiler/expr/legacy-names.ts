/**
 * Earlier spellings of the match-key secret placeholder that compiled SQL may still hold, for
 * example SQL a host compiled and stored before the Dogsled -> Bobsled rename. The rename never
 * rewrites this file (COMPAT_PATHS); the placeholder Core writes now lives in
 * functions-cleaning.ts and follows the rename. Substitution replaces every spelling.
 */
export const LEGACY_MATCH_KEY_SECRET_RUNTIME_TOKENS: readonly string[] = Object.freeze([
  '__DOGSLED_RUNTIME_SECRET_DOGSLED_MATCH_KEY_SECRET__',
]);
