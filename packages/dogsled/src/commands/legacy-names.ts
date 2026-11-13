/**
 * Tutor progress file names, old and new. The Dogsled -> Bobsled rename never rewrites this file
 * (COMPAT_PATHS); Core writes the current name and reads an earlier one, so progress carries over.
 */
export const TUTOR_PROGRESS_FILE_SPELLINGS: readonly string[] = Object.freeze([
  '.dogsled-tutor-progress.json',
  '.bobsled-tutor-progress.json',
]);
