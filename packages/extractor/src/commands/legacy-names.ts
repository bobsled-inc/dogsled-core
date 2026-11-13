/**
 * Root pipeline configuration file names a project may use, old and new. The
 * Dogsled -> Bobsled rename never rewrites this file (COMPAT_PATHS); the name
 * Core writes lives next to the code that writes it and follows the rename.
 * Core reads every spelling and never asks anyone to rename the file.
 */
export const ROOT_CONFIG_FILE_SPELLINGS: readonly string[] = Object.freeze([
  'dogsled.yml',
  'dogsled.yaml',
  'bobsled.yml',
  'bobsled.yaml',
]);
