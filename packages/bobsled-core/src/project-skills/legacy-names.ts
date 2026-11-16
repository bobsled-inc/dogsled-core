/**
 * The names a managed Skill copy's marker file may have, old and new. The Dogsled -> Bobsled
 * rename never rewrites this file (COMPAT_PATHS), so a copy made before the rename stays a
 * managed copy. Core writes the current name and drops an earlier one when it refreshes a copy.
 */
export const COPY_MARKER_SPELLINGS: readonly string[] = Object.freeze([
  '.dogsled-project-skill.json',
  '.bobsled-project-skill.json',
]);
