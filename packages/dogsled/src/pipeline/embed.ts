import type { ProjectIndex } from '@bobsled-inc/project-index';
import { CommandError, EXIT_VALIDATION, withDeclaredAuthEnvVars } from '@bobsled-inc/protocol';

import { requireHostEmbeddingFor } from '../commands/pipeline-run-helpers.js';
import { resolveEmbedStreams } from '../runner/config/embed-streams.js';
import type { ResolvedPipeline } from '../runner/config/loader.js';
import { openProjectForLookup } from '../runner/config/project-files.js';
import type { EmbedConfig } from '../runner/config/schema.js';

interface PipelineEmbed {
  pipeline: ResolvedPipeline;
  embed: EmbedConfig;
  projectRoot: string;
  /** The index of the project, unless a host resolved the pipeline. */
  index: ProjectIndex | undefined;
  declaredEnvNames: readonly string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The embed block a run hands to the embedder: keyed by stream, with the host's declared
 * names. A host that resolves the pipeline may have changed the project files after it read
 * them, so they are read again, as the extractor will read and, where one is broken, report
 * them. Like a destination's missing variable, a missing endpoint or token of a host-supplied
 * model is refused before the run starts.
 */
export function resolvePipelineEmbed({
  pipeline,
  embed,
  projectRoot,
  index,
  declaredEnvNames,
  env,
}: PipelineEmbed): EmbedConfig {
  requireHostEmbeddingFor(embed, env);
  const project = openProjectForLookup(projectRoot, index);
  const { streams, errors } = resolveEmbedStreams(pipeline, embed, project);
  if (errors.length > 0) {
    throw new CommandError(
      errors.map(({ path, message }) => `${path}: ${message}`).join('\n'),
      EXIT_VALIDATION
    );
  }
  return withDeclaredAuthEnvVars({ ...embed, streams }, declaredEnvNames) as EmbedConfig;
}
