import { assertNotHostEmbeddingEnvName } from '@bobsled-inc/protocol';

/** The value of the variable that a field of a warehouse connection names. */
export function readConnectionEnv(name: string, field: string): string {
  assertNotHostEmbeddingEnvName(name);
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable "${name}" (referenced by ${field}) is not set`);
  }
  return value;
}
