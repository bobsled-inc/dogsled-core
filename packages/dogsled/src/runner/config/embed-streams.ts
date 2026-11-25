import { isObject } from '@bobsled-inc/protocol';

import type { ResolvedPipeline, ValidationIssue } from './loader.js';
import { findProjectResource, type DogsledProject } from './project-files.js';
import type { EmbedConfig } from './schema.js';

/** The only column of a chunk stream that holds text to embed. */
const CHUNK_TEXT_FIELD = 'text';

interface DocumentResource {
  /** Every name the pipeline has for the Resource. */
  keys: string[];
  name: string;
  source: Record<string, unknown>;
}

function documentSource(document: unknown): Record<string, unknown> | undefined {
  const source = isObject(document) ? document['source'] : undefined;
  if (!isObject(source)) return undefined;
  const kind = source['kind'] ?? (source['format'] === 'document' ? 'document' : undefined);
  return kind === 'document' ? source : undefined;
}

function documentResources(
  pipeline: ResolvedPipeline,
  project: DogsledProject
): DocumentResource[] {
  return pipeline.resources.flatMap((resource) => {
    const local = findProjectResource(project, pipeline.source, resource.name);
    const source = documentSource(local?.entry.document);
    if (!local || !source) return [];
    return [{ keys: [resource.name, local.name], name: local.name, source }];
  });
}

export interface ResolvedEmbedStreams {
  /** The embed block's streams, keyed by protocol stream name. */
  streams: EmbedConfig['streams'];
  /** The authored keys that name a document Resource. */
  documentKeys: ReadonlySet<string>;
  errors: ValidationIssue[];
}

/**
 * An embed block names Resources. A document Resource has no stream of its own name, so its
 * key stands for the Resource's chunk stream. Every other key is already a stream name.
 * Project validation and every run of an authored pipeline resolve streams here; the
 * embedder itself only knows exact stream names.
 */
export function resolveEmbedStreams(
  pipeline: ResolvedPipeline,
  embed: EmbedConfig,
  project: DogsledProject
): ResolvedEmbedStreams {
  const chunkStreams = new Map(
    documentResources(pipeline, project).flatMap(({ keys, name }) =>
      keys.map((key) => [key, `${name}__chunks`] as const)
    )
  );
  const errors: ValidationIssue[] = [];
  const documentKeys = new Set<string>();
  const streams = new Map<string, EmbedConfig['streams'][string]>();

  for (const [key, fields] of Object.entries(embed.streams)) {
    const path = `dogsled.yml:pipelines.${pipeline.name}.embed.streams.${key}`;
    const chunkStream = chunkStreams.get(key);
    if (chunkStream !== undefined) {
      documentKeys.add(key);
      for (const { field } of fields) {
        if (field === CHUNK_TEXT_FIELD) continue;
        errors.push({
          path: `${path}.${field}`,
          message:
            `resource "${key}" is a document Resource, so only the "${CHUNK_TEXT_FIELD}" of its ` +
            `chunks can be embedded, not "${field}"`,
        });
      }
    }
    const stream = chunkStream ?? key;
    if (streams.has(stream)) {
      errors.push({ path, message: `another key already embeds stream "${stream}"` });
    }
    streams.set(stream, fields);
  }

  return { streams: Object.fromEntries(streams), documentKeys, errors };
}

/** A Resource-level `embedding` block is accepted, but nothing reads it. */
export function ignoredEmbeddingWarnings(
  pipeline: ResolvedPipeline,
  project: DogsledProject
): string[] {
  return documentResources(pipeline, project)
    .filter(({ source }) => source['embedding'] !== undefined)
    .map(
      ({ name }) =>
        `Pipeline "${pipeline.name}": source.embedding on resource "${name}" has no effect; ` +
        `use the pipeline's embed block.`
    );
}
