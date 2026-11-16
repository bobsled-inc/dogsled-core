import { CommandError } from '@bobsled-inc/protocol';

import type { IntegrationSpec } from '../types/index.js';

/**
 * Return an integration spec with `default_transport` overridden to the
 * supplied transport id. Throws `CommandError` if `via` does not match any
 * transport on the spec — the Dogsled-side cross-validator already enforces
 * this for pipelines authored in bobsled.yml (see `validateViaSelections` in
 * the pipeline loader), but the extractor still defends its own boundary
 * because it is invokable standalone.
 *
 * Returns the original reference when `via` is undefined so callers can
 * pass through without conditional branching. Variants of `IntegrationSpec`
 * that do not declare a `transports` array (warehouse, file storage, legacy
 * single-transport API) are passed through unchanged — `--default-via` only
 * applies to multi-transport sources.
 */
export function applyDefaultViaOverride(
  spec: IntegrationSpec,
  via: string | undefined
): IntegrationSpec {
  if (via === undefined) return spec;
  if (!('transports' in spec) || !Array.isArray(spec.transports)) return spec;
  const ids = spec.transports.map((t) => t.id);
  if (!ids.includes(via)) {
    throw new CommandError(
      `--default-via transport "${via}" not found on source "${spec.name}". ` +
        `Available: ${ids.join(', ')}.`
    );
  }
  return { ...spec, default_transport: via };
}

/**
 * Parse one `--resource-via name:id` pair into an object. The shape lives here
 * so both the CLI option's Commander parser and any direct caller share one
 * source of truth. Throws `CommandError` on malformed input — empty name,
 * empty via, or a missing `:` separator.
 */
export function parseResourceViaPair(value: string): { resource: string; via: string } {
  const colon = value.indexOf(':');
  if (colon <= 0) {
    throw new CommandError(`--resource-via expected "<resource>:<via>", got "${value}".`);
  }
  const resource = value.slice(0, colon);
  const via = value.slice(colon + 1);
  if (resource.length === 0 || via.length === 0) {
    throw new CommandError(`--resource-via expected "<resource>:<via>", got "${value}".`);
  }
  return { resource, via };
}

/**
 * Validate every entry in a per-resource via override map against the source
 * integration's declared transports. Dogsled-side cross-validation already
 * covers this for pipelines authored in bobsled.yml, but the extractor still
 * defends its own boundary because `--resource-via` is invokable directly.
 *
 * Single-transport / warehouse / file-storage specs without a `transports`
 * array short-circuit — `--resource-via` is only meaningful for multi-transport
 * sources.
 */
export function validateResourceViaOverride(
  spec: IntegrationSpec,
  viaMap: Record<string, string> | undefined
): void {
  if (!viaMap) return;
  if (!('transports' in spec) || !Array.isArray(spec.transports)) return;
  const ids = spec.transports.map((t) => t.id);
  for (const [resource, via] of Object.entries(viaMap)) {
    if (!ids.includes(via)) {
      throw new CommandError(
        `--resource-via "${resource}:${via}": transport "${via}" not found on source ` +
          `"${spec.name}". Available: ${ids.join(', ')}.`
      );
    }
  }
}
