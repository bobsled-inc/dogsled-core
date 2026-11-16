/**
 * Spellings of Core's names inside Ossie (OSI) files that readers accept, old
 * and new. The Dogsled -> Bobsled rename never rewrites this file
 * (COMPAT_PATHS); the spelling Core writes lives in common.ts. `TRACK`
 * extensions stay foreign data with a `legacy_vendor` warning.
 */
export const OSSIE_VENDOR_SPELLINGS: readonly string[] = Object.freeze(['DOGSLED', 'BOBSLED']);

/** Schemes of project-local dataset sources (`<scheme>models/<name>`, `<scheme>sources/...`). */
export const OSSIE_URI_SCHEMES: readonly string[] = Object.freeze(['dogsled://', 'bobsled://']);
