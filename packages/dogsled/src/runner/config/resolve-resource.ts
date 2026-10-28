import {
  findProjectResource,
  projectResources,
  resourceInSourceFolder,
  type DogsledProject,
} from './project-files.js';

import type { IntegrationsLib, ResolvedPipeline, ValidationIssue } from './loader.js';

function isPathLikeResource(name: string): boolean {
  // Detect both POSIX and Windows separators so a backslash-laden name
  // can't bypass the path-like branch and reach the bare-name resolver.
  return /[\\/]/.test(name);
}

function escapesSourceFolder(name: string): boolean {
  return (
    name.split(/[\\/]/).some((segment) => segment === '..' || segment === '') || /^[\\/]/.test(name)
  );
}

/**
 * Names the project's resources answer to: each resource's
 * `<integration>/<name>` identity, taken from its content wherever the file
 * lives, and for a file under `resources/<source>/` the `<source>/<path>` name
 * that path-like pipeline resources also use.
 */
export function discoverProjectResourceNames(project: DogsledProject): string[] {
  const names = new Set<string>();
  for (const resource of projectResources(project)) {
    names.add(`${resource.integration}/${resource.name}`);
    const pathName = /^resources\/([^/]+\/.+)\.ya?ml$/i.exec(resource.entry.path)?.[1];
    if (pathName) names.add(pathName);
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function resourceExistsBundled(lib: IntegrationsLib, source: string, name: string): boolean {
  try {
    return lib.getIntegration(source).resource_names.includes(name);
  } catch {
    return false;
  }
}

function resourceExistsProjectLocal(
  project: DogsledProject,
  source: string,
  name: string
): boolean {
  return findProjectResource(project, source, name) !== undefined;
}

/**
 * Pull `extract.integration` out of a parsed resource document, if present.
 * Missing fields are covered by validateResourceResolution and by the
 * extractor's stricter schema validation at runtime.
 */
function resourceExtractIntegration(document: unknown): string | undefined {
  const extract = (document as { extract?: { integration?: unknown } } | null)?.extract;
  return typeof extract?.integration === 'string' ? extract.integration : undefined;
}

/**
 * Detect `extract.for_each.resource` from a raw parsed resource payload,
 * independent of resource shape. Both the legacy `{ resource, field, input }`
 * and the multi-binding `{ resource, bindings: [...] }` for_each forms expose
 * `resource`, so pulling it from the raw payload avoids depending on the
 * extractor's runtime parsers. Returns undefined when no for_each is declared.
 */
export interface ForEachDependency {
  parent: string;
  boundInputs: string[];
}

export function forEachDependencyFromRaw(parsed: unknown): ForEachDependency | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const extract = (parsed as { extract?: unknown }).extract;
  if (typeof extract !== 'object' || extract === null) return undefined;
  const forEach = (extract as { for_each?: unknown }).for_each;
  if (typeof forEach !== 'object' || forEach === null) return undefined;
  const resource = (forEach as { resource?: unknown }).resource;
  if (typeof resource !== 'string' || resource.length === 0) return undefined;

  const bindings = (forEach as { bindings?: unknown }).bindings;
  if (Array.isArray(bindings)) {
    const boundInputs = bindings
      .map((binding) =>
        typeof binding === 'object' && binding !== null
          ? (binding as { input?: unknown }).input
          : undefined
      )
      .filter((input): input is string => typeof input === 'string' && input.length > 0);
    return boundInputs.length === bindings.length ? { parent: resource, boundInputs } : undefined;
  }

  // `as` is retained for compatibility with older in-memory integration
  // fixtures and catalogs; current authored specs use `input`.
  const legacy = forEach as { input?: unknown; as?: unknown };
  const input = legacy.input ?? legacy.as;
  return typeof input === 'string' && input.length > 0
    ? { parent: resource, boundInputs: [input] }
    : undefined;
}

export function forEachParentFromRaw(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const extract = (parsed as { extract?: unknown }).extract;
  if (typeof extract !== 'object' || extract === null) return undefined;
  const forEach = (extract as { for_each?: unknown }).for_each;
  if (typeof forEach !== 'object' || forEach === null) return undefined;
  const resource = (forEach as { resource?: unknown }).resource;
  return typeof resource === 'string' && resource.length > 0 ? resource : undefined;
}

/**
 * Cross-check a project-local resource's `extract.integration` field against
 * the active pipeline binding (`pipeline.source`). When they differ, surface
 * a CommandError-shaped validation issue. Catches the bug class where a
 * resource was authored for source X but a pipeline accidentally wires it to
 * source Y — extracting against the wrong source would either fail at runtime
 * or silently pull the wrong table shape.
 */
export function validateResourceSourceAlignment(
  pipeline: ResolvedPipeline,
  project: DogsledProject,
  errors: ValidationIssue[]
): void {
  for (const resource of pipeline.resources) {
    const name = resource.name;
    // Path-like names point at nested files under resources/<source>/. Bare
    // names match a declared resource name, or else the file of that name in
    // the source's folder, so a resource filed under the wrong source reports
    // the integration it declares.
    const local =
      findProjectResource(project, pipeline.source, name) ??
      resourceInSourceFolder(project, pipeline.source, name);
    if (local === undefined) continue;
    const declaredIntegration = resourceExtractIntegration(local.entry.document);
    if (declaredIntegration === undefined) continue;
    if (declaredIntegration !== pipeline.source) {
      errors.push({
        path: `dogsled.yml:pipelines.${pipeline.name}.resources`,
        message:
          `Resource "${name}" declares extract.integration as "${declaredIntegration}" ` +
          `but pipeline "${pipeline.name}" binds it to source "${pipeline.source}". Either ` +
          `update the resource, change the pipeline binding, or remove extract.integration ` +
          `to opt out of this check.`,
      });
    }
  }
}

function getResourceHints(
  lib: IntegrationsLib | undefined,
  source: string
): { variantNames: string[]; entityNames: string[] } {
  if (!lib) return { variantNames: [], entityNames: [] };
  try {
    return {
      variantNames: lib.getIntegration(source).resource_names,
      entityNames: lib.listEntities(source),
    };
  } catch {
    return { variantNames: [], entityNames: [] };
  }
}

export function validateResourceResolution(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib | undefined,
  project: DogsledProject,
  errors: ValidationIssue[],
  warnings: string[]
): void {
  for (const resource of pipeline.resources) {
    const name = resource.name;

    if (isPathLikeResource(name)) {
      if (escapesSourceFolder(name)) {
        errors.push({
          path: `dogsled.yml:pipelines.${pipeline.name}.resources`,
          message:
            `Resource "${name}" escapes resources/${pipeline.source}/ via path traversal. ` +
            `Use a name relative to the source's resource directory.`,
        });
        continue;
      }
      if (!findProjectResource(project, pipeline.source, name)) {
        errors.push({
          path: `dogsled.yml:pipelines.${pipeline.name}.resources`,
          message: `Resource "${name}" not found at resources/${pipeline.source}/${name}.yml`,
        });
      }
      continue;
    }

    const inBundled = lib ? resourceExistsBundled(lib, pipeline.source, name) : false;
    const inProjectLocal = resourceExistsProjectLocal(project, pipeline.source, name);

    if (!inBundled && !inProjectLocal) {
      const { variantNames, entityNames } = getResourceHints(lib, pipeline.source);
      // Surface entity names alongside variant spec names so users who reach
      // for `issues` (entity) get a hint that pairing it with `via:` works,
      // not just a wall of `issues_graphql`/`issues_mcp`-style variants.
      const variantMsg =
        variantNames.length > 0 ? ` Available bundled: ${variantNames.join(', ')}.` : '';
      const entityOnly = entityNames.filter((entity) => !variantNames.includes(entity));
      const entityMsg =
        entityOnly.length > 0 ? ` Or reference by entity with via: ${entityOnly.join(', ')}.` : '';
      errors.push({
        path: `dogsled.yml:pipelines.${pipeline.name}.resources`,
        message: `Resource "${name}" not found in source "${pipeline.source}" (bundled or project-local).${variantMsg}${entityMsg}`,
      });
      continue;
    }

    if (inBundled && inProjectLocal) {
      warnings.push(
        `Pipeline "${pipeline.name}": resource "${name}" exists both in bundled integration "${pipeline.source}" and as a project-local file. Project-local overrides bundled.`
      );
    }
  }
}
