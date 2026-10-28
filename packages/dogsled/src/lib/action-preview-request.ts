import {
  mapTemplateReferences,
  type ApiRequestInterpolationReference,
} from '@bobsled-inc/api-resource';

import type { ActionInputLocation, ActionPreviewRequest } from './action-executor.js';

interface FieldMappingLike {
  fields?: Record<string, string | { source?: string }>;
  unmapped_fields?: string;
}

/** Collects every reference a request plan resolves. */
export function createReferenceCollector(): {
  references: ApiRequestInterpolationReference[];
  onReference: (reference: ApiRequestInterpolationReference) => void;
} {
  const references: ApiRequestInterpolationReference[] = [];
  return { references, onReference: (reference) => references.push(reference) };
}

function locationOf(path: string): ActionInputLocation {
  if (path.endsWith('.unclassified')) return 'other';
  if (path === 'api.base_url' || path.startsWith('api.base_url.')) return 'base_url';
  if (path === 'api.endpoint' || path === 'webhook.url') return 'path';
  if (path === 'api.endpoint.origin' || path === 'webhook.url.origin') return 'origin';
  if (
    path === 'api.endpoint.query' ||
    path === 'webhook.url.query' ||
    path.startsWith('query_params.')
  ) {
    return 'query';
  }
  if (
    path.startsWith('headers.') ||
    path.startsWith('optional_headers.') ||
    path.startsWith('webhook.headers.')
  ) {
    return 'header';
  }
  if (/^(?:webhook\.)?request_body(?:$|[.[])/.test(path)) return 'body';
  if (/^auth(?:$|[.[])/.test(path)) return 'auth';
  if (path === 'api.base_url') return 'base_url';
  return 'other';
}

const NOT_FROM_INPUT = Symbol('not from input');

/**
 * The input a mapped value came from. `mapFields` replaces an absent or null
 * source with the mapping default or leaves it undefined, so such a value is
 * reported as coming from no input. `undefined` means the source is unknown.
 */
function mappedInput(
  key: string,
  mapping: FieldMappingLike | undefined,
  inputs: Record<string, unknown>
): string | typeof NOT_FROM_INPUT | undefined {
  const entry = mapping?.fields?.[key];
  const source =
    typeof entry === 'string'
      ? entry
      : entry !== undefined
        ? entry.source
        : mapping?.unmapped_fields === 'passthrough' && Object.hasOwn(inputs, key)
          ? key
          : undefined;
  if (source === undefined) return undefined;
  return inputs[source] === undefined || inputs[source] === null ? NOT_FROM_INPUT : source;
}

function mappedPlaceholder(
  key: string,
  mapping: FieldMappingLike | undefined,
  inputs: Record<string, unknown>
) {
  const input = mappedInput(key, mapping, inputs);
  return typeof input === 'string' ? input : `mapped.${key}`;
}

function placeholderFor(
  reference: { source: string; key?: string },
  mapping: FieldMappingLike | undefined,
  inputs: Record<string, unknown>
) {
  if (reference.key === undefined) return `{${reference.source}}`;
  if (reference.source === 'input') return `{${reference.key}}`;
  if (reference.source === 'mapped') {
    return `{${mappedPlaceholder(reference.key, mapping, inputs)}}`;
  }
  return `{${reference.source}.${reference.key}}`;
}

/**
 * The path the planner sends to, with references as `{name}` placeholders: a
 * relative endpoint appended to the base URL's pathname, or an absolute
 * endpoint's own pathname, parsed by WHATWG URL so dot segments, backslashes
 * and percent-encoding read as they are sent. Undefined when the URL cannot be
 * parsed without its values, such as a base URL that is entirely a reference.
 */
function pathTemplate(
  endpoint: string,
  baseUrl: string | undefined,
  mapping: FieldMappingLike | undefined,
  inputs: Record<string, unknown>
): string | undefined {
  let marker = 'trackref';
  while (endpoint.includes(marker) || baseUrl?.includes(marker)) marker += 'x';
  const placeholders: string[] = [];
  const withSentinels = (template: string) =>
    mapTemplateReferences(template, (reference) => {
      placeholders.push(placeholderFor(reference, mapping, inputs));
      return `${marker}${placeholders.length - 1}${marker}`;
    });
  let pathname: string;
  if (endpoint.startsWith('https://') || endpoint.startsWith('http://')) {
    const absolute = withSentinels(endpoint);
    if (!URL.canParse(absolute)) return undefined;
    pathname = new URL(absolute).pathname;
  } else {
    if (baseUrl === undefined || !endpoint.startsWith('/')) return undefined;
    const base = withSentinels(baseUrl);
    if (!URL.canParse(base)) return undefined;
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/$/, '') + withSentinels(endpoint);
    pathname = url.pathname;
  }
  return pathname.replace(
    new RegExp(`${marker}(\\d+)${marker}`, 'g'),
    (token, index: string) => placeholders[Number(index)] ?? token
  );
}

/**
 * Describe where a planned request sends each input, from the references the
 * planner actually resolved. Holds names and locations only, never values.
 */
export function describeActionRequest(params: {
  method: string;
  endpoint?: string;
  baseUrl?: string;
  references: readonly ApiRequestInterpolationReference[];
  fieldMapping?: FieldMappingLike;
  inputs: Record<string, unknown>;
}): ActionPreviewRequest {
  const inputLocations = new Map<string, ActionInputLocation[]>();
  const wholeInputLocations: ActionInputLocation[] = [];
  const add = (locations: ActionInputLocation[], location: ActionInputLocation) => {
    if (!locations.includes(location)) locations.push(location);
  };
  for (const reference of params.references) {
    if (reference.source !== 'input' && reference.source !== 'mapped') continue;
    const location = locationOf(reference.path);
    if (reference.key === undefined) {
      add(wholeInputLocations, location);
      continue;
    }
    const input =
      reference.source === 'input'
        ? params.inputs[reference.key] === undefined
          ? NOT_FROM_INPUT
          : reference.key
        : mappedInput(reference.key, params.fieldMapping, params.inputs);
    if (input === NOT_FROM_INPUT) continue;
    if (input === undefined) {
      add(wholeInputLocations, location);
      continue;
    }
    const locations = inputLocations.get(input) ?? [];
    add(locations, location);
    inputLocations.set(input, locations);
  }
  const pathTemplateText =
    params.endpoint === undefined
      ? undefined
      : pathTemplate(params.endpoint, params.baseUrl, params.fieldMapping, params.inputs);
  return {
    method: params.method,
    ...(pathTemplateText === undefined ? {} : { path_template: pathTemplateText }),
    input_locations: Object.fromEntries(inputLocations),
    whole_input_locations: wholeInputLocations,
  };
}
