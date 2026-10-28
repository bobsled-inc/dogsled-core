/**
 * Pluggable secret resolution.
 *
 * A `SecretResolver` turns an env-var name (either the token inside
 * `${{ env.VAR }}` or the value of a legacy `<field>_env` key) into the
 * plaintext value that integration construction needs. The CLI default
 * reads `process.env`; managed-mode hosts (e.g. the host application) register
 * their own resolver backed by an encrypted secret store.
 *
 * The interface is intentionally tiny — one async lookup. Model Spec never sees
 * plaintext secrets except at the moment the runner is built, and the
 * resolver is free to log / audit / rate-limit individual lookups.
 */

export interface SecretResolver {
  readonly declaredSecretNames?: readonly string[];
  /**
   * Return the plaintext value for the given env-var name.
   *
   * @throws When the name is unknown or the underlying store denies access.
   *         Implementations should prefer `CommandError(msg, 2)` so Model Spec CLI
   *         exit codes match the project's convention.
   */
  resolve(envVarName: string): Promise<string>;
}
