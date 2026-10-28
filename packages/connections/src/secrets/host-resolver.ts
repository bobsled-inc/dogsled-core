import { AuthEnvVarsSchema, CommandError } from '@bobsled-inc/protocol';
import type { SecretResolver } from './types.js';

export function withDeclaredSecretNames(
  resolver: SecretResolver | undefined,
  names: readonly string[]
): SecretResolver {
  if (!resolver) {
    throw new CommandError('declaredSecretNames requires an explicit host secretResolver.', 2);
  }
  const parsed = AuthEnvVarsSchema.safeParse(names);
  if (!parsed.success) {
    throw new CommandError('declaredSecretNames must contain valid environment variable names.', 2);
  }
  return {
    declaredSecretNames: [...new Set([...(resolver.declaredSecretNames ?? []), ...parsed.data!])],
    resolve: (name) => resolver.resolve(name),
  };
}
