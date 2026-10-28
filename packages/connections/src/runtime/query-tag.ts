import { CommandError } from '@bobsled-inc/protocol';

/** Safe operational upper bound for a trusted warehouse query tag. */
export const QUERY_TAG_MAX_LENGTH = 256;

const CONTROL_CHARACTER_RE = /[\x00-\x1F\x7F-\x9F]/;

/**
 * Validate trusted, per-run query metadata.
 *
 * Query tags are supplied programmatically at runner construction time; they
 * deliberately are not accepted from integration YAML.
 */
export function validateQueryTag(queryTag: unknown): string | undefined {
  if (queryTag === undefined) return undefined;
  if (typeof queryTag !== 'string') {
    throw new CommandError('Query tag must be a string.', 2);
  }
  if (queryTag.trim().length === 0) {
    throw new CommandError('Query tag must not be empty.', 2);
  }
  if (queryTag.length > QUERY_TAG_MAX_LENGTH) {
    throw new CommandError(`Query tag must be at most ${QUERY_TAG_MAX_LENGTH} characters.`, 2);
  }
  if (CONTROL_CHARACTER_RE.test(queryTag)) {
    throw new CommandError('Query tag must not contain control characters.', 2);
  }
  return queryTag;
}
