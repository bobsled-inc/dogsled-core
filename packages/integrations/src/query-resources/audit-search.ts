import type {
  HttpApiResourceSpec,
  QueryResourceCandidateSearch,
  QueryResourceSearchDialect,
} from './audit-types.js';
import { collectHttpParamBodyInputRefs } from './audit-input-refs.js';

const SEARCH_INPUT_NAMES = new Set([
  'q',
  'query',
  'search',
  'search_term',
  'search_string',
  'jql',
  'search_query',
]);

export function getServiceNowSearchBlock(
  integrationName: string,
  resource: HttpApiResourceSpec
): QueryResourceCandidateSearch | undefined {
  if (integrationName !== 'servicenow') {
    return undefined;
  }

  const queryInput = resource.input.query;
  if (
    !queryInput ||
    queryInput.type !== 'string' ||
    queryInput.required === true ||
    !collectHttpParamBodyInputRefs(resource.api).has('query') ||
    typeof queryInput.default !== 'string' ||
    !queryInput.default.includes('ORDERBY')
  ) {
    return undefined;
  }

  return {
    input: 'query',
    dialect: 'servicenow_sysparm_query',
    ...(queryInput.description ? { description: queryInput.description } : {}),
  };
}

export function getFrontSearchBlock(
  integrationName: string,
  resource: HttpApiResourceSpec
): QueryResourceCandidateSearch | undefined {
  if (integrationName !== 'front') {
    return undefined;
  }

  const queryInput = resource.input.q;
  if (
    !queryInput ||
    queryInput.type !== 'string' ||
    queryInput.required === true ||
    !collectHttpParamBodyInputRefs(resource.api).has('q') ||
    !queryInput.description?.includes('Search query')
  ) {
    return undefined;
  }

  return {
    input: 'q',
    dialect: 'front_q_query_object',
    description: queryInput.description,
  };
}

export function getCandidateSearch(
  resource: HttpApiResourceSpec,
  boundInputs?: Set<string>
): QueryResourceCandidateSearch | undefined {
  const resolvedBoundInputs = boundInputs ?? collectHttpParamBodyInputRefs(resource.api);

  for (const inputName of Object.keys(resource.input).sort()) {
    const inputField = resource.input[inputName];
    if (
      !inputField ||
      inputField.required === true ||
      inputField.type !== 'string' ||
      !SEARCH_INPUT_NAMES.has(inputName) ||
      !resolvedBoundInputs.has(inputName)
    ) {
      continue;
    }

    return {
      input: inputName,
      dialect: getSearchDialect(inputName),
      ...(inputField.description ? { description: inputField.description } : {}),
    };
  }

  return undefined;
}

function getSearchDialect(inputName: string): QueryResourceSearchDialect {
  if (inputName === 'jql') {
    return 'jira_jql';
  }
  return 'provider_search';
}
