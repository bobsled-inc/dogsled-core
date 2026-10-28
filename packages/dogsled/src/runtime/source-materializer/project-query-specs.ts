import { IntegrationSpecSchema, ResourceSpecSchema } from '@bobsled-inc/extractor/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import {
  assertValidProjectIndex,
  entriesOfKind,
  documentName,
  resourceIntegration,
  scanProject,
} from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';

export function projectQuerySpecLoader(projectRoot: string): typeof loadQueryableResourceSpecs {
  const index = scanProject(projectRoot);
  assertValidProjectIndex(index);
  return (integrationName, resourceName, options = {}) => {
    const local = entriesOfKind(index, 'integration').find(
      (entry) => documentName(entry) === integrationName
    );
    if (!local) return loadQueryableResourceSpecs(integrationName, resourceName, options);
    const candidate = entriesOfKind(index, 'resource').find(
      (entry) =>
        documentName(entry) === resourceName && resourceIntegration(entry) === integrationName
    );
    if (!candidate) {
      throw new CommandError(
        `Resource "${resourceName}" not found for local integration "${integrationName}"`,
        2
      );
    }
    const integration = IntegrationSpecSchema.parse(local.document);
    const resource = ResourceSpecSchema.parse(candidate.document);
    if (
      !('transport' in integration) ||
      integration.transport.type !== 'http' ||
      !('api' in resource) ||
      !resource.api ||
      !('query' in resource) ||
      !resource.query ||
      (resource.billing && !options.includeBillable)
    ) {
      return undefined;
    }
    return { integration, resource } as NonNullable<ReturnType<typeof loadQueryableResourceSpecs>>;
  };
}
