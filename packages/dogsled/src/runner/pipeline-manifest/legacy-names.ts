/**
 * Every spelling of the pipeline manifest's names that a reader accepts, from
 * all three Core generations (Track, Dogsled, Bobsled). The Dogsled -> Bobsled
 * rename never rewrites this file (COMPAT_PATHS); the spelling Core writes lives
 * in template.ts and manifest-schema.ts and follows the rename. Every spelling
 * parses to the current one. Manifests of version 6 and older stay rejected as
 * unsupported versions, whatever their spelling. The command contract keeps
 * two spellings: no Track command or setting is still installed.
 */
export const MANIFEST_SPELLINGS = Object.freeze({
  kind: Object.freeze(['track.pipeline.dag', 'dogsled.pipeline.dag', 'bobsled.pipeline.dag']),
  cli_version_field: Object.freeze([
    'track_cli_version',
    'dogsled_cli_version',
    'bobsled_cli_version',
  ]),
  default_command: Object.freeze(['dogsled', 'bobsled']),
  command_env: Object.freeze(['DOGSLED_PIPELINE_COMMAND', 'BOBSLED_CORE_PIPELINE_COMMAND']),
  cwd_env: Object.freeze(['DOGSLED_PIPELINE_CWD', 'BOBSLED_CORE_PIPELINE_CWD']),
  timeout_seconds_env: Object.freeze([
    'DOGSLED_PIPELINE_TIMEOUT_SECONDS',
    'BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS',
  ]),
  run_resource: Object.freeze([
    'track.runner.run_resource',
    'dogsled.runner.run_resource',
    'bobsled.runner.run_resource',
  ]),
  model_run: Object.freeze(['track.model.run', 'dogsled.model.run', 'bobsled.model.run']),
  entity_graph_run: Object.freeze([
    'track.entity_graph.run',
    'dogsled.entity_graph.run',
    'bobsled.entity_graph.run',
  ]),
} as const);
