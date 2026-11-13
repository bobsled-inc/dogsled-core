/**
 * The names a Project Skill's metadata sidecar may have, old and new. The Dogsled -> Bobsled
 * rename never rewrites this file (COMPAT_PATHS), so a stored Skill keeps its triggers and
 * references whichever name its sidecar has. A package with both is invalid.
 */
export const SKILL_SIDECAR_SPELLINGS: readonly string[] = Object.freeze([
  'dogsled.yaml',
  'bobsled.yaml',
]);
