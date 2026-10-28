import type { OpenAPIV3 } from 'openapi-types';

const CURSOR_QUERY_PARAMS = new Set([
  'cursor',
  'after',
  'starting_after',
  'page_token',
  'next_token',
  'continuation_token',
]);

const CURSOR_RESPONSE_FIELDS = new Set([
  'next_cursor',
  'end_cursor',
  'next_page_token',
  'has_more',
  'has_next',
  'cursor',
]);

const OFFSET_PARAMS = new Set(['offset', 'skip', 'startat', 'start_at']);
const LIMIT_PARAMS = new Set([
  'limit',
  'count',
  'page_size',
  'per_page',
  'maxresults',
  'max_results',
]);
const PAGE_NUMBER_PARAMS = new Set(['page', 'page_number']);
const PER_PAGE_PARAMS = new Set(['per_page', 'page_size', 'limit']);
const NEXT_URL_FIELDS = new Set(['next', 'next_url', 'next_page', 'next_link']);

export function detectPagination(
  parameters: OpenAPIV3.ParameterObject[],
  responseSchema: OpenAPIV3.SchemaObject | null
): Record<string, unknown> | null {
  const queryParamsByLower = new Map<string, OpenAPIV3.ParameterObject>();
  for (const parameter of parameters) {
    if (parameter.in === 'query') {
      queryParamsByLower.set(parameter.name.toLowerCase(), parameter);
    }
  }

  const responsePropNames = responseSchema?.properties
    ? Object.keys(responseSchema.properties)
    : [];
  const responsePropsByLower = new Map<string, string>();
  for (const name of responsePropNames) {
    responsePropsByLower.set(name.toLowerCase(), name);
  }

  const isNumericParameter = (parameter: OpenAPIV3.ParameterObject | undefined): boolean => {
    const schema = parameter?.schema as OpenAPIV3.SchemaObject | undefined;
    return schema?.type === 'integer' || schema?.type === 'number';
  };

  const cursorQueryKey = [...queryParamsByLower.keys()].find((key) => CURSOR_QUERY_PARAMS.has(key));
  const cursorRespKey = [...responsePropsByLower.keys()].find((key) => {
    if (!CURSOR_RESPONSE_FIELDS.has(key)) {
      return false;
    }

    const actualField = responsePropsByLower.get(key)!;
    const schema = responseSchema?.properties?.[actualField] as OpenAPIV3.SchemaObject | undefined;
    return schema?.type !== 'boolean';
  });
  if (cursorQueryKey && cursorRespKey) {
    const actualParam = queryParamsByLower.get(cursorQueryKey)!;
    const actualRespField = responsePropsByLower.get(cursorRespKey)!;
    return {
      type: 'cursor',
      cursor_param: actualParam.name,
      cursor_path: `$.${actualRespField}`,
    };
  }

  const offsetKey = [...queryParamsByLower.keys()].find((key) => OFFSET_PARAMS.has(key));
  const limitKey = [...queryParamsByLower.keys()].find((key) => LIMIT_PARAMS.has(key));
  if (
    offsetKey &&
    limitKey &&
    isNumericParameter(queryParamsByLower.get(offsetKey)) &&
    isNumericParameter(queryParamsByLower.get(limitKey))
  ) {
    return {
      type: 'offset',
      offset_param: queryParamsByLower.get(offsetKey)!.name,
      limit_param: queryParamsByLower.get(limitKey)!.name,
    };
  }

  const pageKey = [...queryParamsByLower.keys()].find((key) => PAGE_NUMBER_PARAMS.has(key));
  if (pageKey) {
    const result: Record<string, unknown> = {
      type: 'page_number',
      page_param: queryParamsByLower.get(pageKey)!.name,
    };
    const perPageKey = [...queryParamsByLower.keys()].find((key) => PER_PAGE_PARAMS.has(key));
    if (perPageKey) {
      result['per_page_param'] = queryParamsByLower.get(perPageKey)!.name;
    }
    return result;
  }

  const nextUrlKey = [...responsePropsByLower.keys()].find((key) => NEXT_URL_FIELDS.has(key));
  if (nextUrlKey) {
    const actualField = responsePropsByLower.get(nextUrlKey)!;
    const propSchema = responseSchema?.properties?.[actualField] as
      | OpenAPIV3.SchemaObject
      | undefined;
    if (!propSchema || propSchema.type === 'string') {
      return {
        type: 'next_url',
        next_url_path: `$.${actualField}`,
      };
    }
  }

  return null;
}
