/**
 * Root pipeline configuration file names a project may use, from all three Core generations
 * (Track, Dogsled, Bobsled). The Dogsled -> Bobsled rename never rewrites this file
 * (COMPAT_PATHS); the name Core writes lives next to the code that writes it and follows the
 * rename. Core reads every spelling and never asks anyone to rename the file. Every package that
 * looks for a root configuration imports this one list.
 */
export const ROOT_CONFIG_FILE_SPELLINGS: readonly string[] = Object.freeze([
  'track.yml',
  'track.yaml',
  'dogsled.yml',
  'dogsled.yaml',
  'bobsled.yml',
  'bobsled.yaml',
]);
