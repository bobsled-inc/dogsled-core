import { resolveWarehouseCheckpointTarget } from '../agentic/warehouse-checkpoint-target.js';
import { CommandError } from '../errors.js';
import type { LoadedProject } from './load-project.js';

export function checkpointIntegration(project: LoadedProject) {
  const config = project.config.checkpointStore;
  if (!config) return undefined;
  const integration = project.integrations.get(config.integration);
  if (!integration) {
    throw new CommandError('checkpoint_store references an unknown integration', 2);
  }
  try {
    resolveWarehouseCheckpointTarget(integration.integration, config);
  } catch (cause) {
    throw new CommandError(cause instanceof Error ? cause.message : 'Invalid checkpoint target', 2);
  }
  return integration;
}
