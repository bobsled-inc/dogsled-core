import type { IntegrationsLib, ResolvedPipeline, ValidationIssue } from './loader.js';
import { findProjectResource, type BobsledProject } from './project-files.js';
import { resolveEntityVariant } from './resolve-entity.js';
import {
  type ForEachDependency,
  forEachDependencyFromRaw,
  forEachParentFromRaw,
} from './resolve-resource.js';
import { getRunnerCapabilities } from './runner-catalog.js';

/**
 * Populate manifest grouping metadata for resources that iterate a selected
 * sibling through `extract.for_each`.
 */
export function enrichForEachParents(
  pipelines: ResolvedPipeline[],
  lib: IntegrationsLib | undefined,
  project: BobsledProject
): void {
  for (const pipeline of pipelines) {
    const inPipeline = new Set(pipeline.resources.map((resource) => resource.name));
    const tokenToSpec = new Map<string, string>();
    const specToToken = new Map<string, string>();

    if (lib) {
      const clone: ResolvedPipeline = {
        ...pipeline,
        resources: pipeline.resources.map((resource) => ({ ...resource })),
      };
      try {
        resolveEntityVariant(clone, lib, project, []);
      } catch {
        // Authoritative validation reports resolution failures; enrichment
        // falls back to authored names.
      }
      pipeline.resources.forEach((resource, index) => {
        const spec = clone.resources[index]?.name ?? resource.name;
        tokenToSpec.set(resource.name, spec);
        if (!specToToken.has(spec)) specToToken.set(spec, resource.name);
      });
    }

    for (const resource of pipeline.resources) {
      const dependency =
        readProjectLocalForEachDependency(project, pipeline.source, resource.name) ??
        bundledForEachDependency(
          lib,
          pipeline.source,
          tokenToSpec.get(resource.name) ?? resource.name
        );
      if (!dependency) continue;
      if (hasEveryBoundInput(pipeline, resource, dependency)) {
        delete resource.forEachParent;
        continue;
      }
      if (resource.forEachParent) continue;
      const parentSpec = dependency.parent;
      const parentToken = specToToken.get(parentSpec) ?? parentSpec;
      if (inPipeline.has(parentToken)) resource.forEachParent = parentToken;
    }
  }
}

/**
 * Validate that every `for_each` child in a pipeline can actually run:
 * the runner supports iteration and the child's parent is selected in the
 * same pipeline. The parent must run first in the shared extraction process
 * so the child can read its records from the in-memory cache.
 */
export function validateForEachIteration(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib | undefined,
  project: BobsledProject,
  errors: ValidationIssue[]
): void {
  const caps = getRunnerCapabilities(pipeline.runner);
  const inPipeline = new Set(pipeline.resources.map((resource) => resource.name));

  for (const resource of pipeline.resources) {
    const dependency = authoredForEachDependency(pipeline.source, resource.name, lib, project);
    if (!dependency) {
      if (
        resource.forEachParent &&
        resourceSpecIsAvailable(pipeline.source, resource.name, lib, project)
      ) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
          message:
            `Resource "${resource.requestedName ?? resource.name}" declares for_each_parent ` +
            `"${resource.forEachParent}", but its resource spec has no extract.for_each edge. ` +
            'Remove the synthetic parent override.',
        });
      }
      continue;
    }
    if (hasEveryBoundInput(pipeline, resource, dependency)) {
      continue;
    }
    const parent = dependency.parent;

    if (resource.forEachParent) {
      const resolvePipelineName = (name: string): string =>
        pipeline.resources.find(
          (candidate) => candidate.name === name || candidate.requestedName === name
        )?.name ?? name;
      if (resolvePipelineName(resource.forEachParent) !== resolvePipelineName(parent)) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
          message:
            `Resource "${resource.requestedName ?? resource.name}" declares for_each_parent ` +
            `"${resource.forEachParent}", but its resource spec iterates "${parent}". ` +
            'Remove the override or make it match extract.for_each.resource.',
        });
        continue;
      }
    }

    if (!caps.supports_for_each_iteration) {
      errors.push({
        path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
        message:
          `Resource "${resource.name}" iterates "${parent}" via extract.for_each, but runner ` +
          `"${pipeline.runner}" does not support for_each iteration. Switch to a runner that ` +
          `does, or remove "${resource.name}" from the pipeline.`,
      });
      continue;
    }

    if (!inPipeline.has(parent)) {
      errors.push({
        path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
        message:
          `Resource "${resource.name}" iterates for_each parent "${parent}", which is not ` +
          `selected in pipeline "${pipeline.name}". The parent must run in the same pipeline so ` +
          `it lands the records "${resource.name}" fans out over — add "${parent}" to the ` +
          `pipeline's resources.`,
      });
    }
  }
}

function resourceSpecIsAvailable(
  source: string,
  resourceName: string,
  lib: IntegrationsLib | undefined,
  project: BobsledProject
): boolean {
  if (findProjectResource(project, source, resourceName)) return true;
  if (!lib) return false;
  try {
    return lib.getResources(source).some(({ resource }) => resource.name === resourceName);
  } catch {
    return false;
  }
}

/**
 * Resolve a resource's authored `extract.for_each` parent spec name without
 * requiring the parent to be selected in the pipeline. Project-local YAML
 * shadows the bundled spec. Returns `undefined` when the resource declares no
 * `for_each`.
 */
export function authoredForEachParent(
  source: string,
  resourceSpecName: string,
  lib: IntegrationsLib | undefined,
  project: BobsledProject
): string | undefined {
  return (
    readProjectLocalForEachParent(project, source, resourceSpecName) ??
    bundledForEachParent(lib, source, resourceSpecName)
  );
}

export function authoredForEachDependency(
  source: string,
  resourceSpecName: string,
  lib: IntegrationsLib | undefined,
  project: BobsledProject
): ForEachDependency | undefined {
  return (
    readProjectLocalForEachDependency(project, source, resourceSpecName) ??
    bundledForEachDependency(lib, source, resourceSpecName)
  );
}

function hasEveryBoundInput(
  pipeline: ResolvedPipeline,
  resource: ResolvedPipeline['resources'][number],
  dependency: ForEachDependency
): boolean {
  const inputs = { ...pipeline.inputs, ...resource.override?.inputs };
  return dependency.boundInputs.every((inputName) => Object.hasOwn(inputs, inputName));
}

function readProjectLocalForEachDependency(
  project: BobsledProject,
  source: string,
  name: string
): ForEachDependency | undefined {
  const local = findProjectResource(project, source, name);
  return local ? forEachDependencyFromRaw(local.entry.document) : undefined;
}

function readProjectLocalForEachParent(
  project: BobsledProject,
  source: string,
  name: string
): string | undefined {
  const local = findProjectResource(project, source, name);
  return local ? forEachParentFromRaw(local.entry.document) : undefined;
}

function bundledForEachParent(
  lib: IntegrationsLib | undefined,
  source: string,
  specName: string
): string | undefined {
  if (!lib) return undefined;
  try {
    for (const { resource } of lib.getResources(source)) {
      if (resource.name === specName) return forEachParentFromRaw(resource);
    }
  } catch {
    // Unknown/custom sources and incomplete mocks have no bundled metadata.
    return undefined;
  }
  return undefined;
}

function bundledForEachDependency(
  lib: IntegrationsLib | undefined,
  source: string,
  specName: string
): ForEachDependency | undefined {
  if (!lib) return undefined;
  try {
    for (const { resource } of lib.getResources(source)) {
      if (resource.name === specName) return forEachDependencyFromRaw(resource);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
