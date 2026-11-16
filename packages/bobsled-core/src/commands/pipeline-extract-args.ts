import { CommandError } from '@bobsled-inc/protocol';
import type { PipelineOptions } from './pipeline.js';

/**
 * Host declarations already validated against the explicit host map, narrowed
 * to the names the extractor child actually receives. Destination-only
 * credentials (for example Snowflake workload identity sources and any alias
 * holding the same token) are removed from the extractor environment, so they
 * must not be declared to it either.
 */
export function extractorDeclaredEnvNames(
  declaredEnvNames: readonly string[] | undefined,
  extractorEnv: NodeJS.ProcessEnv
): string[] {
  return (declaredEnvNames ?? []).filter(
    (name) => Object.hasOwn(extractorEnv, name) && extractorEnv[name] !== undefined
  );
}

export function buildPipelineExtractArgs(
  resourceNames: string[],
  options: PipelineOptions,
  embedConfigPath: string | undefined,
  deferStateWrite: boolean,
  extractorEnv: NodeJS.ProcessEnv
): string[] {
  // Resource names come from Project configuration and land in argv as
  // positionals, so one must never parse as a flag: `--host-env-names-json`
  // decides which reserved credentials the extractor may read.
  const flagLikeName = resourceNames.find((name) => name.startsWith('-'));
  if (flagLikeName !== undefined) {
    throw new CommandError(`Invalid resource name "${flagLikeName}".`, 2);
  }
  const args = ['run', ...resourceNames, '--integration', options.integration];
  // Sent even when empty: the flag also tells the extractor a host owns this
  // run, so its ambient environment grants no reserved credentials.
  if (options.declaredEnvNames !== undefined) {
    args.push(
      '--host-env-names-json',
      JSON.stringify(extractorDeclaredEnvNames(options.declaredEnvNames, extractorEnv))
    );
  }

  if (options.fullRefresh || options.startDate || options.endDate) {
    args.push('--full-refresh');
  }
  if (options.batch) args.push('--batch');
  if (options.batchFormat) args.push('--batch-format', options.batchFormat);
  if (options.emitModelSpecSource) {
    args.push('--emit-model-spec-source');
    if (embedConfigPath) args.push('--embed-config-file', embedConfigPath);
  }
  args.push(deferStateWrite ? '--no-state-write' : '--advance-state');
  if (options.batchSize) args.push('--batch-size', String(options.batchSize));
  if (options.limit) args.push('--limit', String(options.limit));
  if (options.stateBackend) args.push('--state-backend', options.stateBackend);
  if (options.warehouse !== undefined) args.push('--warehouse', options.warehouse);
  if (options.queryTag !== undefined) args.push('--query-tag', options.queryTag);
  if (options.verbose) args.push('--verbose');
  // Child telemetry stays structured and complete even when the parent presents
  // pretty or quiet logs. The parent parses metrics first, then decides which
  // lines to display.
  args.push('--log-format', 'json');
  if (options.via) args.push('--default-via', options.via);
  if (options.resourceVia) {
    for (const name of Object.keys(options.resourceVia).sort()) {
      args.push('--resource-via', `${name}:${options.resourceVia[name]}`);
    }
  }
  // Per-resource inputs travel as ONE JSON payload rather than delimited pairs:
  // input values are arbitrary user data (they may contain `:`, `=`, commas, or
  // newlines), so a `<resource>:<key>=<value>` flag could not round-trip them
  // safely. Keys are sorted so the emitted argv stays deterministic.
  if (options.resourceInputs && Object.keys(options.resourceInputs).length > 0) {
    const sorted = Object.fromEntries(
      Object.keys(options.resourceInputs)
        .sort()
        .map((name) => [name, options.resourceInputs![name]])
    );
    args.push('--resource-inputs-json', JSON.stringify(sorted));
  }
  if (options.resourceInputMatrices && Object.keys(options.resourceInputMatrices).length > 0) {
    const sorted = Object.fromEntries(
      Object.keys(options.resourceInputMatrices)
        .sort()
        .map((name) => [name, options.resourceInputMatrices![name]])
    );
    args.push('--resource-input-matrices-json', JSON.stringify(sorted));
  }
  if (
    options.resourceInputMatrixConcurrency &&
    Object.keys(options.resourceInputMatrixConcurrency).length > 0
  ) {
    const sorted = Object.fromEntries(
      Object.keys(options.resourceInputMatrixConcurrency)
        .sort()
        .map((name) => [name, options.resourceInputMatrixConcurrency![name]])
    );
    args.push('--resource-input-matrix-concurrency-json', JSON.stringify(sorted));
  }
  for (const input of options.input ?? []) {
    args.push('--input', input);
  }
  if (options.startDate) args.push('--input', `start_date=${options.startDate}`);
  if (options.endDate) args.push('--input', `end_date=${options.endDate}`);

  return args;
}
