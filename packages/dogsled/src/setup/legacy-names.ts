/**
 * Setup answers file names a project may hold, old and new. The Dogsled ->
 * Bobsled rename never rewrites this file (COMPAT_PATHS); Core writes the
 * current name and reads an earlier one in place.
 */
export const SETUP_ANSWERS_FILE_SPELLINGS: readonly string[] = Object.freeze([
  'dogsled.setup.answers.yml',
  'bobsled.setup.answers.yml',
]);
