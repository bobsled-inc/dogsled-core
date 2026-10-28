import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import type { ModelConnection, PlatformConfig } from './types.js';

export function resolveModelConnection(
  role: string,
  projectConfig: { platform?: PlatformConfig }
): ModelConnection {
  const connection = projectConfig.platform?.models?.[role];
  if (!connection) {
    throw new CommandError(
      `Model role "${role}" is not defined in platform.models`,
      EXIT_VALIDATION
    );
  }
  return connection;
}
