import {
  assertNotHostEmbeddingEnvName,
  CommandError,
  parseEnvPlaceholder,
} from '@bobsled-inc/protocol';

export function resolveEnvPlaceholder(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  label = 'a destination setting in dogsled.yml'
): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const envName = parseEnvPlaceholder(value);
  if (!envName) {
    throw new CommandError(
      `Invalid environment variable name in placeholder for ${label}. Use format $ENV_VAR_NAME or \${{ env.ENV_VAR_NAME }}.`,
      2
    );
  }

  assertNotHostEmbeddingEnvName(envName);
  const resolved = env[envName];
  if (resolved === undefined) {
    throw new CommandError(`Missing environment variable: ${envName}`, 2);
  }

  return resolved;
}
