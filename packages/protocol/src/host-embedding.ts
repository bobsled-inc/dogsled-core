import { CommandError, EXIT_VALIDATION } from './definitions.js';

/** Endpoint of the embedding model a host application supplies for a `provider: host` stage. */
export const HOST_EMBEDDING_URL_ENV = 'DOGSLED_HOST_EMBEDDING_URL';
/** Bearer token for that endpoint. */
export const HOST_EMBEDDING_TOKEN_ENV = 'DOGSLED_HOST_EMBEDDING_TOKEN';

export const HOST_EMBEDDING_ENV_NAMES = [HOST_EMBEDDING_URL_ENV, HOST_EMBEDDING_TOKEN_ENV] as const;

export const HOST_EMBEDDING_ENV_RESERVED_MESSAGE =
  `${HOST_EMBEDDING_URL_ENV} and ${HOST_EMBEDDING_TOKEN_ENV} are reserved for the ` +
  'provider: host embedding stage';

const RESERVED_NAMES: ReadonlySet<string> = new Set(HOST_EMBEDDING_ENV_NAMES);

/** An environment name ends at a NUL, and Windows ignores its case. */
export function isHostEmbeddingEnvName(name: string): boolean {
  return RESERVED_NAMES.has(name.split('\0', 1)[0]!.toUpperCase());
}

export function assertNotHostEmbeddingEnvName(name: string): void {
  if (isHostEmbeddingEnvName(name)) {
    throw new CommandError(`${HOST_EMBEDDING_ENV_RESERVED_MESSAGE}.`, EXIT_VALIDATION);
  }
}

/** The environment without the host embedding endpoint and token. */
export function withoutHostEmbeddingEnv<T extends Record<string, string | undefined>>(env: T): T {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isHostEmbeddingEnvName(name))
  ) as T;
}

/** Remove both names from `env` itself, so a process started later cannot inherit them. */
export function deleteHostEmbeddingEnv(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (isHostEmbeddingEnvName(name)) delete env[name];
  }
}

/**
 * The endpoint and token the host application set for this run. Only a
 * `provider: host` embedding stage may call this.
 */
export function requireHostEmbeddingEnv(env: Record<string, string | undefined>): {
  url: string;
  token: string;
} {
  const url = env[HOST_EMBEDDING_URL_ENV];
  const token = env[HOST_EMBEDDING_TOKEN_ENV];
  if (!url || !token) {
    const missing = HOST_EMBEDDING_ENV_NAMES.filter((name) => !env[name]);
    throw new CommandError(
      `Embedding provider "host" needs ${HOST_EMBEDDING_ENV_NAMES.join(' and ')}, which the ` +
        `host application sets for the run. Not set: ${missing.join(', ')}.`,
      EXIT_VALIDATION
    );
  }
  return { url, token };
}
