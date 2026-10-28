import type { QueryPredicate, QueryPredicateOperator, QueryPredicateValue } from './types.js';
import { QueryBuilderError } from './types.js';

const OPERATOR_MAP: Record<string, QueryPredicateOperator> = {
  '=': 'eq',
  '==': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  contains: 'contains',
  in: 'in',
};

const FILTER_RE = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(>=|<=|!=|==|=|>|<|contains|in)\s*(.+?)\s*$/i;

export function parseFilterExpression(expression: string): QueryPredicate[] {
  const trimmed = expression.trim();
  if (!trimmed) {
    return [];
  }

  return splitTopLevelPredicates(trimmed).map((part) => parsePredicate(part));
}

function parsePredicate(expression: string): QueryPredicate {
  const match = FILTER_RE.exec(expression);
  if (!match) {
    throw new QueryBuilderError(`Unsupported filter expression "${expression}".`);
  }

  const [, field, rawOperator, rawValue] = match;
  const operator = OPERATOR_MAP[rawOperator!.toLowerCase()];
  if (!operator) {
    throw new QueryBuilderError(`Unsupported filter operator "${rawOperator}".`);
  }

  return {
    field: field!,
    operator,
    value: operator === 'in' ? parseArrayValue(rawValue!) : parseScalarValue(rawValue!),
  };
}

function parseArrayValue(rawValue: string): QueryPredicateValue {
  const trimmed = rawValue.trim();
  const inner = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  const values = splitTopLevelCsv(inner)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseScalarValue);

  if (values.length === 0) {
    throw new QueryBuilderError('Filter expression "in" requires at least one value.');
  }
  return values;
}

function parseScalarValue(rawValue: string): string | number | boolean {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unescapeQuotedScalar(trimmed.slice(1, -1), trimmed[0]!);
  }

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && trimmed !== '') {
    return numeric;
  }

  return trimmed;
}

function unescapeQuotedScalar(value: string, quote: string): string {
  return value.replace(/\\(["'\\nrt])/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '"':
      case "'":
        return escaped === quote ? escaped : `\\${escaped}`;
      case '\\':
        return '\\';
      default:
        return escaped;
    }
  });
}

function splitTopLevelPredicates(expression: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\n') {
      const match = /^\s+and\s+/i.exec(expression.substring(index));
      if (match) {
        parts.push(expression.slice(start, index).trim());
        index += match[0].length - 1;
        start = index + 1;
      }
    }
  }

  parts.push(expression.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

export function appendSearchValue(search: string, append: string | undefined): string {
  if (!append) {
    return search;
  }
  if (search.length === 0 && append.startsWith('^')) {
    return append.slice(1);
  }
  return `${search}${append}`;
}

function splitTopLevelCsv(expression: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ',') {
      parts.push(expression.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(expression.slice(start));
  return parts;
}
