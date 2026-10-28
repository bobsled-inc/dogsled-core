import {
  isQueryBindInputCompatible,
  QUERY_SCALAR_FIELD_TYPES,
  type QueryOperator,
} from '@bobsled-inc/extractor/extractor';

import type {
  GeneratedFilterAnalysis,
  HttpApiResourceSpec,
  QueryResourceAuditBlocker,
  QueryResourceAuditBlockerReason,
  QueryResourceCandidateFilter,
  ScalarFieldType,
  SuggestedQueryFilter,
  SuggestedQuerySpec,
} from './audit-types.js';
import { collectHttpParamBodyInputRefs } from './audit-input-refs.js';

interface FieldBindingCandidate {
  input: string;
  field: string;
  operator: QueryOperator;
}

const LOWER_BOUND_PREFIXES = ['min_', 'from_', 'after_'];
const UPPER_BOUND_PREFIXES = ['max_', 'to_', 'before_'];
const LOWER_BOUND_SUFFIXES = ['_start', '_from', '_after', '_since', '_gte'];
const UPPER_BOUND_SUFFIXES = ['_end', '_to', '_before', '_until', '_lte'];

export function analyzeGeneratedFilters(
  resource: HttpApiResourceSpec,
  boundInputs?: Set<string>
): GeneratedFilterAnalysis {
  const resolvedBoundInputs = boundInputs ?? collectHttpParamBodyInputRefs(resource.api);
  const candidates: FieldBindingCandidate[] = [];
  const blockers: QueryResourceAuditBlocker[] = [];

  for (const inputName of Object.keys(resource.input).sort()) {
    const inputField = resource.input[inputName];
    if (!inputField || inputField.required === true || !resolvedBoundInputs.has(inputName)) {
      continue;
    }

    const bindingCandidate = getFieldBindingCandidate(inputName, resource);
    if (!bindingCandidate) {
      continue;
    }

    const outputField = resource.output[bindingCandidate.field];
    if (!outputField) {
      continue;
    }

    if (!QUERY_SCALAR_FIELD_TYPES.has(inputField.type)) {
      blockers.push(
        buildBlocker({
          input: inputName,
          field: bindingCandidate.field,
          operator: bindingCandidate.operator,
          reason: 'input_not_scalar',
          inputType: inputField.type,
          outputType: outputField.type,
        })
      );
      continue;
    }

    if (!QUERY_SCALAR_FIELD_TYPES.has(outputField.type)) {
      blockers.push(
        buildBlocker({
          input: inputName,
          field: bindingCandidate.field,
          operator: bindingCandidate.operator,
          reason: 'output_not_scalar',
          inputType: inputField.type,
          outputType: outputField.type,
        })
      );
      continue;
    }

    if (!isQueryBindInputCompatible(outputField.type, inputField.type)) {
      blockers.push(
        buildBlocker({
          input: inputName,
          field: bindingCandidate.field,
          operator: bindingCandidate.operator,
          reason: 'incompatible_scalar_types',
          inputType: inputField.type,
          outputType: outputField.type,
        })
      );
      continue;
    }

    candidates.push(bindingCandidate);
  }

  const candidateFilters = buildCandidateFilters(candidates, resource);
  return {
    candidateFilters,
    blockers: blockers.sort(compareBlockers),
    suggestedQuery: buildSuggestedQuery(candidateFilters),
  };
}

function getFieldBindingCandidate(
  inputName: string,
  resource: HttpApiResourceSpec
): FieldBindingCandidate | undefined {
  if (Object.hasOwn(resource.output, inputName)) {
    return {
      input: inputName,
      field: inputName,
      operator: getOperatorForInputName(inputName),
    };
  }

  const rangeCandidate = getRangeCandidate(inputName);
  if (rangeCandidate && Object.hasOwn(resource.output, rangeCandidate.field)) {
    return {
      input: inputName,
      field: rangeCandidate.field,
      operator: rangeCandidate.operator,
    };
  }

  const incremental = resource.incremental ?? resource.extract.incremental;
  const sinceArgument =
    incremental && 'since_argument' in incremental ? incremental.since_argument : undefined;
  const untilArgument =
    incremental && 'until_argument' in incremental ? incremental.until_argument : undefined;
  const cursorField =
    incremental && 'cursor_field' in incremental ? incremental.cursor_field : undefined;
  if (
    incremental &&
    cursorField &&
    (inputName === sinceArgument || inputName === untilArgument) &&
    Object.hasOwn(resource.output, cursorField)
  ) {
    return {
      input: inputName,
      field: cursorField,
      operator: inputName === sinceArgument ? 'gte' : 'lte',
    };
  }

  return undefined;
}

function getRangeCandidate(
  inputName: string
): { field: string; operator: QueryOperator } | undefined {
  for (const prefix of LOWER_BOUND_PREFIXES) {
    if (inputName.startsWith(prefix) && inputName.length > prefix.length) {
      return {
        field: inputName.slice(prefix.length),
        operator: 'gte',
      };
    }
  }

  for (const prefix of UPPER_BOUND_PREFIXES) {
    if (inputName.startsWith(prefix) && inputName.length > prefix.length) {
      return {
        field: inputName.slice(prefix.length),
        operator: 'lte',
      };
    }
  }

  for (const suffix of LOWER_BOUND_SUFFIXES) {
    if (inputName.endsWith(suffix) && inputName.length > suffix.length) {
      return {
        field: inputName.slice(0, -suffix.length),
        operator: 'gte',
      };
    }
  }

  for (const suffix of UPPER_BOUND_SUFFIXES) {
    if (inputName.endsWith(suffix) && inputName.length > suffix.length) {
      return {
        field: inputName.slice(0, -suffix.length),
        operator: 'lte',
      };
    }
  }

  return undefined;
}

function getOperatorForInputName(inputName: string): QueryOperator {
  return getRangeCandidate(inputName)?.operator ?? 'eq';
}

function buildCandidateFilters(
  candidates: FieldBindingCandidate[],
  resource: HttpApiResourceSpec
): QueryResourceCandidateFilter[] {
  const filtersByField = new Map<string, QueryResourceCandidateFilter>();

  for (const candidate of candidates.sort(compareFieldBindingCandidates)) {
    const outputField = resource.output[candidate.field];
    if (!outputField || !isScalarFieldType(outputField.type)) {
      continue;
    }

    const existing = filtersByField.get(candidate.field);
    if (existing) {
      if (!existing.operators.includes(candidate.operator)) {
        existing.operators.push(candidate.operator);
      }
      existing.bind[candidate.operator] = candidate.input;
      existing.operators.sort(compareOperators);
      continue;
    }

    const inputField = resource.input[candidate.input];
    const enumValues = inputField?.enum?.filter(
      (value): value is string => typeof value === 'string'
    );
    const description = inputField?.description ?? outputField.description;
    filtersByField.set(candidate.field, {
      field: candidate.field,
      type: outputField.type,
      operators: [candidate.operator],
      bind: {
        [candidate.operator]: candidate.input,
      },
      ...(enumValues && enumValues.length > 0 ? { enum: enumValues } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...filtersByField.values()].sort((left, right) => left.field.localeCompare(right.field));
}

function buildSuggestedQuery(
  candidateFilters: QueryResourceCandidateFilter[]
): SuggestedQuerySpec | undefined {
  if (candidateFilters.length === 0) {
    return undefined;
  }

  const filters: Record<string, SuggestedQueryFilter> = {};
  for (const filter of candidateFilters) {
    const bind: Partial<Record<QueryOperator, { input: string }>> = {};
    for (const operator of filter.operators) {
      const input = filter.bind[operator];
      if (input) {
        bind[operator] = { input };
      }
    }

    filters[filter.field] = {
      operators: [...filter.operators],
      bind,
      ...(filter.enum ? { enum: [...filter.enum] } : {}),
      ...(filter.description ? { description: filter.description } : {}),
    };
  }

  return { filters };
}

function isScalarFieldType(type: string): type is ScalarFieldType {
  return QUERY_SCALAR_FIELD_TYPES.has(type);
}

function buildBlocker(params: {
  input: string;
  field: string;
  operator: QueryOperator;
  reason: QueryResourceAuditBlockerReason;
  inputType: string;
  outputType: string;
}): QueryResourceAuditBlocker {
  return {
    ...params,
    message: getBlockerMessage(params),
  };
}

function getBlockerMessage(params: {
  input: string;
  field: string;
  reason: QueryResourceAuditBlockerReason;
  inputType: string;
  outputType: string;
}): string {
  if (params.reason === 'input_not_scalar') {
    return `input "${params.input}" type "${params.inputType}" must be scalar before it can bind to output field "${params.field}"`;
  }
  if (params.reason === 'output_not_scalar') {
    return `output field "${params.field}" type "${params.outputType}" must be scalar before it can be queried`;
  }
  return `input "${params.input}" type "${params.inputType}" is not compatible with output field "${params.field}" type "${params.outputType}"`;
}

function compareFieldBindingCandidates(
  left: FieldBindingCandidate,
  right: FieldBindingCandidate
): number {
  return (
    left.field.localeCompare(right.field) ||
    compareOperators(left.operator, right.operator) ||
    left.input.localeCompare(right.input)
  );
}

function compareBlockers(
  left: QueryResourceAuditBlocker,
  right: QueryResourceAuditBlocker
): number {
  return (
    left.field.localeCompare(right.field) ||
    compareOperators(left.operator, right.operator) ||
    left.input.localeCompare(right.input) ||
    left.reason.localeCompare(right.reason)
  );
}

function compareOperators(left: QueryOperator, right: QueryOperator): number {
  return getOperatorSortOrder(left) - getOperatorSortOrder(right);
}

function getOperatorSortOrder(operator: QueryOperator): number {
  switch (operator) {
    case 'eq':
      return 0;
    case 'contains':
      return 1;
    case 'gte':
      return 2;
    case 'lte':
      return 3;
    case 'ne':
      return 4;
    case 'lt':
      return 5;
    case 'gt':
      return 6;
    case 'not':
      return 7;
    case 'in':
      return 8;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}
