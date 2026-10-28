/**
 * Deprecation warning for legacy `*_env` suffixed fields in warehouse integration schemas.
 *
 * Logs a one-time warning per field name per process. Consumers should call
 * `warnLegacyEnvField()` when they encounter a legacy-shape field during
 * env resolution.
 */

const warned = new Set<string>();

/**
 * Legacy fields whose schema also accepts the unsuffixed name. Other `*_env`
 * fields (PostgreSQL, MySQL, Redshift and ClickHouse hosts and credentials)
 * have no replacement yet, so warning about them would send users to a field
 * that validation rejects.
 */
export const LEGACY_ENV_FIELDS_WITH_REPLACEMENT: ReadonlySet<string> = new Set([
  'account_identifier_env',
  'client_id_env',
  'client_secret_env',
  'credentials_env',
  'private_key_passphrase_env',
  'private_key_path_env',
  'token_env',
  'user_env',
  'warehouse_env',
]);

/**
 * Emit a deprecation warning for a legacy `*_env` suffixed field that has a
 * replacement. Logs at most once per field name per process to avoid log spam.
 */
export function warnLegacyEnvField(fieldName: string): void {
  if (!LEGACY_ENV_FIELDS_WITH_REPLACEMENT.has(fieldName)) return;
  if (warned.has(fieldName)) return;
  warned.add(fieldName);

  const newField = fieldName.replace(/_env$/, '');
  process.stderr.write(
    `[deprecation] Field "${fieldName}" is deprecated; use "${newField}" with $\{{ env.X }} interpolation instead.\n`
  );
}

/**
 * Reset the warning tracker. Intended only for tests.
 */
export function resetLegacyEnvWarnings(): void {
  warned.clear();
}
