import { isObject } from '@bobsled-inc/protocol';

import type { ResolvedPipeline, ValidationIssue } from './loader.js';
import { findProjectResource, type DogsledProject } from './project-files.js';
import type { DogsledConfig } from './schema.js';

/** The destinations that can write a file as it is. */
const FILE_DESTINATION_TYPES = new Set(['local', 's3', 'gcs']);

/** The most S3 takes in one write, which is how the loader writes a file. */
const S3_MAX_OBJECT_BYTES = 5 * 1024 ** 3;

/**
 * A copy Resource hands each file to one loader, which deletes it once it has written it.
 * A list of destinations replays the extractor's output to each loader after the extractor
 * finishes, which a copy cannot survive: the extractor waits for the loader to delete files.
 * The extractor refuses the same run, for a pipeline that skipped this check. A table
 * destination cannot write a file at all, so it is refused here, before any download.
 */
export function validateCopyDestinations(
  pipeline: ResolvedPipeline,
  config: DogsledConfig,
  project: DogsledProject,
  errors: ValidationIssue[]
): void {
  const path = `dogsled.yml:pipelines.${pipeline.name}.destinations`;
  for (const resource of pipeline.resources) {
    const document = findProjectResource(project, pipeline.source, resource.name)?.entry.document;
    const source = isObject(document) ? document['source'] : undefined;
    if (!isObject(source) || source['kind'] !== 'copy') continue;

    const name = resource.requestedName ?? resource.name;
    if (pipeline.destinationNames.length > 1) {
      errors.push({
        path,
        message:
          `Resource "${name}" copies files, so it needs one destination, not a list of ` +
          `destinations (${pipeline.destinationNames.join(', ')}).`,
      });
      continue;
    }
    const limits = isObject(document) && isObject(document['limits']) ? document['limits'] : {};
    const largest = limits['max_file_size_bytes'];
    for (const destinationName of pipeline.destinationNames) {
      const type = config.destinations[destinationName]?.type;
      if (type !== undefined && !FILE_DESTINATION_TYPES.has(type)) {
        errors.push({
          path,
          message:
            `Resource "${name}" copies files, so its destination must be local, s3 or gcs, ` +
            `but "${destinationName}" is ${type}.`,
        });
      }
      if (type === 's3' && typeof largest === 'number' && largest > S3_MAX_OBJECT_BYTES) {
        errors.push({
          path,
          message:
            `Resource "${name}" allows files of up to ${largest} bytes, but S3 takes at most ` +
            `${S3_MAX_OBJECT_BYTES} bytes in one write. Lower limits.max_file_size_bytes, or ` +
            `copy to a local or gcs destination instead of "${destinationName}".`,
        });
      }
    }
  }
}
