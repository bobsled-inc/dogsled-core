/**
 * Earlier names of Core's source-materializer tables. The Dogsled -> Bobsled
 * rename never rewrites this file (COMPAT_PATHS); the current name lives in
 * metadata.ts and follows the rename.
 */

/** Earlier names of the source metadata table (cursors, ETags, snapshot leases). */
export const LEGACY_METADATA_TABLES: readonly string[] = Object.freeze([
  '_dogsled_source_metadata',
]);
