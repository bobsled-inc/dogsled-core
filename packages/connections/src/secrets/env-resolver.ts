/**
 * Default `SecretResolver` — reads from `process.env`.
 *
 * This is the resolver Model Spec CLI users get out of the box. Managed-mode hosts
 * (host application) pass their own `SecretResolver` instead, backed by an
 * encrypted secret store.
 */

import { assertNotHostEmbeddingEnvName, CommandError } from '@bobsled-inc/protocol';

import type { SecretResolver } from './types.js';

export class EnvSecretResolver implements SecretResolver {
  private readonly source: Record<string, string | undefined>;

  /**
   * @param source Optional alternate env bag for tests; defaults to
   *               `process.env`. Accepted as a dependency so unit tests do
   *               not mutate the real process environment.
   */
  constructor(source: Record<string, string | undefined> = process.env) {
    this.source = source;
  }

  async resolve(envVarName: string): Promise<string> {
    assertNotHostEmbeddingEnvName(envVarName);
    const value = this.source[envVarName];
    if (value === undefined || value === '') {
      throw new CommandError(`Environment variable "${envVarName}" is not set`, 2);
    }
    return value;
  }
}
