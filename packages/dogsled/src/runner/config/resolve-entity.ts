import { findProjectResource, type DogsledProject } from './project-files.js';

import type { IntegrationsLib, ResolvedPipeline, ValidationIssue } from './loader.js';

/**
 * Rewrite entity-name resource references on a pipeline to their concrete
 * variant spec names, in place. Strict-name references (the existing behavior
 * — `cycles_mcp`, `issues_graphql`) pass through unchanged, as do path-like
 * project-local references (e.g. `subdir/issues`) and bare names that match
 * a project resource declared for the source. The existing
 * `validateResourceResolution` remains the authority on project-local lookup.
 *
 * Resolution order for each `resources:` entry on a pipeline:
 *   1. Strict-name lookup against the source's `resource_names` — wins first
 *      so every authored config that previously parsed cleanly keeps
 *      working.
 *   2. Project-local override check — if the project declares a resource
 *      with that name for the source, the user is overriding bundled, so leave
 *      the name untouched and let project-local resolution handle it.
 *   3. Single-variant fallback — if the entity has exactly one variant on
 *      this source, auto-pick it. No via is required because there's nothing
 *      to disambiguate.
 *   4. Multi-variant fallback — requires an effective `via:` (per-resource
 *      overrides pipeline-level). On a unique hit, `resource.name` becomes
 *      the variant's spec name and `resource.requestedName` records the
 *      original token.
 *
 * The unknown-entity-and-unknown-name case is intentionally NOT reported here
 * — `validateResourceResolution` already owns "Resource not found" with the
 * available list, and we want one source of truth for that error so callers
 * can rely on its phrasing.
 */
export function resolveEntityVariant(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib,
  project: DogsledProject,
  errors: ValidationIssue[]
): void {
  let resourceNames: Set<string>;
  try {
    resourceNames = new Set(lib.getIntegration(pipeline.source).resource_names);
  } catch {
    // Source-not-found is reported in step 4 of validateDogsledConfig; nothing
    // useful we can resolve here.
    return;
  }

  for (const resource of pipeline.resources) {
    const requestedName = resource.name;
    // Strict-name match wins — path-like references (containing `/`) flow
    // through here too because the project-local resolver downstream handles
    // them; we only rewrite when entity resolution genuinely fires.
    if (resourceNames.has(requestedName)) continue;
    if (requestedName.includes('/')) continue;

    // Project-local override wins over bundled entity resolution — matches the
    // precedence rule documented in validateResourceResolution. Without this
    // guard, a project `issues` resource would be silently shadowed by
    // `issues_mcp` whenever the pipeline declared via.
    if (findProjectResource(project, pipeline.source, requestedName)) continue;

    const variants = lib.getEntityVariants(pipeline.source, requestedName);
    if (variants.length === 0) {
      // No entity match — leave the name untouched and let
      // validateResourceResolution emit the canonical "Resource not found"
      // error so we don't double-report.
      continue;
    }

    // Echo back the resource segment the user wrote — matches the path shape
    // used by `validateViaSelections` so editors can jump directly to the row.
    const errorPath = `dogsled.yml:pipelines.${pipeline.name}.resources.${requestedName}`;
    const effectiveVia = resource.override?.via ?? pipeline.via;

    // Single-variant entities don't need a via to disambiguate — pick the
    // only variant. This is the common case for sources that have just one
    // transport per entity even when the source as a whole is multi-transport.
    if (variants.length === 1) {
      const match = variants[0]!;
      if (effectiveVia !== undefined && match.via !== undefined && match.via !== effectiveVia) {
        errors.push({
          path: errorPath,
          message:
            `No variant for entity "${requestedName}" with via "${effectiveVia}" ` +
            `on source "${pipeline.source}". Available: ${match.via} → ${match.name}.`,
        });
        continue;
      }
      resource.requestedName = requestedName;
      resource.name = match.name;
      continue;
    }

    if (effectiveVia === undefined) {
      errors.push({
        path: errorPath,
        message:
          `Resource "${requestedName}" on source "${pipeline.source}" has multiple ` +
          `transport variants (${variants.map((v) => v.via ?? '<none>').join(', ')}) ` +
          `but no via: was provided. Set pipeline-level "via:" or per-resource ` +
          `"via:" to disambiguate, or reference a specific variant by name ` +
          `(${variants.map((v) => v.name).join(', ')}).`,
      });
      continue;
    }

    const matches = variants.filter((v) => v.via === effectiveVia);
    if (matches.length === 0) {
      const available = variants.map((v) => `${v.via ?? '<none>'} → ${v.name}`).join(', ');
      errors.push({
        path: errorPath,
        message:
          `No variant for entity "${requestedName}" with via "${effectiveVia}" ` +
          `on source "${pipeline.source}". Available variants: ${available}.`,
      });
      continue;
    }

    const match = matches[0]!;
    resource.requestedName = requestedName;
    resource.name = match.name;
  }
}
