import { withDeclaredAuthEnvVars, withDeclaredModelApiKey } from '@bobsled-inc/protocol';
import type { ExperimentalAgenticProbe } from './probe.js';

export function withHostModelDeclarations(
  platform: ExperimentalAgenticProbe['platform'],
  names: readonly string[] = []
): ExperimentalAgenticProbe['platform'] {
  if (!names.length || !platform.models) return platform;
  return {
    ...platform,
    models: Object.fromEntries(
      Object.entries(platform.models).map(([name, connection]) => [
        name,
        withDeclaredAuthEnvVars(connection, names),
      ])
    ),
  };
}

export function withHostManagedModelAuth(
  platform: ExperimentalAgenticProbe['platform']
): ExperimentalAgenticProbe['platform'] {
  if (!platform.models) return platform;
  return {
    ...platform,
    models: Object.fromEntries(
      Object.entries(platform.models).map(([name, connection]) => [
        name,
        withDeclaredModelApiKey(connection),
      ])
    ),
  };
}
