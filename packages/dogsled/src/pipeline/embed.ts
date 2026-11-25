import { CommandError, EXIT_VALIDATION, withDeclaredAuthEnvVars } from '@bobsled-inc/protocol';

import { resolveEmbedStreams } from '../runner/config/embed-streams.js';
import type { ResolvedPipeline } from '../runner/config/loader.js';
import { openDogsledProject } from '../runner/config/project-files.js';
import type { EmbedConfig } from '../runner/config/schema.js';

/**
 * The embed block a run hands to the embedder: keyed by stream, with the host's declared
 * names. It reads the project files the extractor will read, so a host that resolves the
 * pipeline itself gets the same streams.
 */
export function resolvePipelineEmbed(
  pipeline: ResolvedPipeline,
  embed: EmbedConfig,
  projectRoot: string,
  declaredEnvNames: readonly string[]
): EmbedConfig {
  const { streams, errors } = resolveEmbedStreams(pipeline, embed, openDogsledProject(projectRoot));
  if (errors.length > 0) {
    throw new CommandError(
      errors.map(({ path, message }) => `${path}: ${message}`).join('\n'),
      EXIT_VALIDATION
    );
  }
  return withDeclaredAuthEnvVars({ ...embed, streams }, declaredEnvNames) as EmbedConfig;
}
