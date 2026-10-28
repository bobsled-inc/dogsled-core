/**
 * Compatibility exports for the extractor's interpolation helpers.
 *
 * Request interpolation is shared with the catalog-only probe in the
 * dependency-light protocol package. Keep this file as the established
 * extractor import path so normal extraction and probing cannot drift.
 */

export {
  InterpolationError,
  interpolatePath,
  interpolateString,
  interpolateValue,
} from '@bobsled-inc/api-resource';
export type {
  ApiRequestInterpolationContext as InterpolationContext,
  ApiRequestInterpolationMappedValues as InterpolationMappedValues,
} from '@bobsled-inc/api-resource';

export function parseInputFlags(entries: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const entry of entries) {
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex === -1) {
      throw new Error(`Invalid --input format "${entry}". Expected key=value.`);
    }

    result[entry.slice(0, equalsIndex)] = entry.slice(equalsIndex + 1);
  }

  return result;
}
