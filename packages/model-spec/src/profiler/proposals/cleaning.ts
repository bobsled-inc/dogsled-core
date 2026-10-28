import type { CleaningSuggestion, CleaningTransform, ProfileEvidence } from '../types.js';

import { clampConfidence, normalizeName, roundRate, sampleExamples } from '../inferences/utils.js';

interface UsState {
  code: string;
  name: string;
}

export interface SuggestCleaningForColumnInput {
  column: string;
  values: unknown[];
}

export interface SuggestCleaningColumnInput {
  name: string;
  values: unknown[];
}

export interface SuggestCleaningInput {
  columns: SuggestCleaningColumnInput[];
}

const LEGAL_SUFFIX_RE =
  /\b(inc|incorporated|llc|l\.?l\.?c\.?|ltd|limited|corp|corporation|co|company)\.?$/i;
const TRADING_AS_RE = /\b(d\s*\/\s*b\s*\/\s*a|dba|trading\s+as|t\s*\/\s*a)\b/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const US_DATE_RE = /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}$/;
const EU_DATE_RE = /^(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])\/\d{4}$/;
const US_STATES: UsState[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];
const STATE_NAMES = new Set(US_STATES.map((state) => state.name.toLowerCase()));
const STATE_CODES = new Set(US_STATES.map((state) => state.code));

export function suggestCleaningForColumn(
  input: SuggestCleaningForColumnInput
): CleaningSuggestion[] {
  const strings = input.values.filter((value) => typeof value === 'string') as string[];
  if (strings.length === 0) return [];

  const suggestions: CleaningSuggestion[] = [];
  const columnName = normalizeName(input.column);
  const isEmailColumn = columnName.includes('email');
  const isCompanyColumn =
    columnName.includes('company') || columnName.includes('account') || columnName === 'name';
  const isUrlColumn =
    columnName.includes('domain') || columnName.includes('website') || columnName.includes('url');
  const isPhoneColumn = columnName.includes('phone') || columnName.includes('mobile');

  const whitespaceRate = rate(strings, (value) => value !== value.trim());
  const repeatedWhitespaceRate = rate(strings, (value) => /\s{2,}/.test(value));
  const lowerNeededRate = rate(strings, (value) => value !== value.toLowerCase());
  const upperNeededRate = rate(strings, (value) => value.length <= 3 && /[a-z]/.test(value));
  const emptyStringRate = rate(strings, (value) => value.trim() === '');
  const legalSuffixRate = rate(strings, (value) => LEGAL_SUFFIX_RE.test(value.trim()));
  const tradingAsRate = rate(strings, (value) => TRADING_AS_RE.test(value));
  const protocolRate = rate(strings, (value) => /^https?:\/\//i.test(value.trim()));
  const wwwRate = rate(strings, (value) => /^(https?:\/\/)?www\./i.test(value.trim()));
  const urlPathRate = rate(
    strings,
    (value) =>
      /^https?:\/\//i.test(value.trim()) && /[/?#]/.test(value.trim().replace(/^https?:\/\//i, ''))
  );
  const emailRate = rate(strings, (value) => EMAIL_RE.test(value.trim()));
  const emailSubaddressRate = rate(strings, (value) => /^[^@\s]+\+[^@\s]*@/.test(value.trim()));
  const accentedRate = rate(strings, (value) => /[^\u0000-\u007F]/.test(value));
  const nonDigitPhoneRate = rate(strings, (value) => /\D/.test(value) && digits(value).length >= 7);
  const phoneExtensionRate = rate(strings, (value) =>
    /\b(ext\.?|extension|x)\s*#?\s*\d+\s*$/i.test(value)
  );
  const countryCodeRate = rate(
    strings,
    (value) => digits(value).length === 11 && digits(value).startsWith('1')
  );
  const parseableDateRate = rate(
    strings,
    (value) => /^\d{4}-\d{2}-\d{2}/.test(value.trim()) && !Number.isNaN(Date.parse(value))
  );
  const usDateRate = rate(strings, (value) => US_DATE_RE.test(value.trim()));
  const euDateRate = rate(strings, (value) => EU_DATE_RE.test(value.trim()));
  const formattedNumberRate = rate(strings, (value) =>
    /^\s*[$€£]?\s*-?\d{1,3}(,\d{3})+(\.\d+)?\s*$/.test(value)
  );
  const stateRate = rate(
    strings,
    (value) =>
      STATE_CODES.has(value.trim().toUpperCase()) || STATE_NAMES.has(value.trim().toLowerCase())
  );

  if (emptyStringRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['nullif_empty'],
        emptyStringRate,
        strings,
        'Convert empty strings to NULL',
        {
          emptyStringRate,
        }
      )
    );
  }
  if (whitespaceRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['trim'],
        whitespaceRate,
        strings,
        'Remove leading/trailing whitespace',
        {
          changedRowRate: whitespaceRate,
        }
      )
    );
  }
  if (repeatedWhitespaceRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['collapse_whitespace'],
        repeatedWhitespaceRate,
        strings,
        'Collapse repeated whitespace before matching',
        { changedRowRate: repeatedWhitespaceRate }
      )
    );
  }
  if (isEmailColumn && lowerNeededRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['normalize_email'],
        lowerNeededRate,
        strings,
        'Normalize email casing',
        {
          changedRowRate: lowerNeededRate,
        }
      )
    );
  } else if (
    (columnName.includes('domain') || columnName.includes('name')) &&
    lowerNeededRate >= 0.1
  ) {
    suggestions.push(
      suggestion(
        input.column,
        ['lowercase'],
        lowerNeededRate,
        strings,
        'Normalize casing for comparisons',
        {
          changedRowRate: lowerNeededRate,
        }
      )
    );
  }
  if (isEmailColumn && emailRate >= 0.6) {
    suggestions.push(
      suggestion(
        input.column,
        ['extract_email_domain'],
        emailRate,
        strings,
        'Extract email domains for account matching',
        {
          emailRate,
        }
      )
    );
  }
  if (isEmailColumn && emailSubaddressRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['strip_email_subaddress', 'normalize_email'],
        emailSubaddressRate,
        strings,
        'Remove email plus-addressing before matching',
        { emailSubaddressRate }
      )
    );
  }
  if ((columnName === 'state' || columnName.endsWith('_state')) && upperNeededRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['uppercase'],
        upperNeededRate,
        strings,
        'Uppercase short state codes',
        {
          changedRowRate: upperNeededRate,
        }
      )
    );
  }
  if (isCompanyColumn && tradingAsRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['strip_trading_as', 'normalize_company'],
        tradingAsRate,
        strings,
        'Remove trading-as aliases and normalize company names',
        { tradingAsRate }
      )
    );
  }
  if (isCompanyColumn && legalSuffixRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['normalize_company'],
        Math.max(legalSuffixRate, lowerNeededRate),
        strings,
        'Remove legal suffix and normalize company names',
        { legalSuffixRate, casingChangedRate: lowerNeededRate }
      )
    );
  }
  if (isUrlColumn && urlPathRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['extract_domain'],
        urlPathRate,
        strings,
        'Extract comparable domains from URLs',
        {
          urlPathRate,
        }
      )
    );
  } else if (isUrlColumn && (protocolRate >= 0.1 || wwwRate >= 0.1)) {
    suggestions.push(
      suggestion(
        input.column,
        ['strip_protocol', 'strip_www', 'lowercase'],
        Math.max(protocolRate, wwwRate, lowerNeededRate),
        strings,
        'Normalize URL/domain values before joining',
        { protocolRate, wwwRate, casingChangedRate: lowerNeededRate }
      )
    );
  }
  if (isPhoneColumn && nonDigitPhoneRate >= 0.1) {
    const transforms: CleaningTransform[] =
      phoneExtensionRate >= 0.1
        ? ['strip_phone_extension', 'normalize_phone']
        : ['normalize_phone'];
    suggestions.push(
      suggestion(
        input.column,
        transforms,
        nonDigitPhoneRate,
        strings,
        'Normalize phone comparisons',
        {
          nonDigitPhoneRate,
          countryCodeRate,
          phoneExtensionRate,
        }
      )
    );
  }
  if (accentedRate >= 0.1) {
    suggestions.push(
      suggestion(
        input.column,
        ['strip_accents'],
        accentedRate,
        strings,
        'Remove accents before matching',
        {
          accentedRate,
        }
      )
    );
  }
  if (formattedNumberRate >= 0.6) {
    suggestions.push(
      suggestion(
        input.column,
        ['parse_number'],
        formattedNumberRate,
        strings,
        'Parse formatted numeric strings',
        {
          formattedNumberRate,
        }
      )
    );
  }
  if (usDateRate >= 0.8 && !columnName.endsWith('_at') && !columnName.endsWith('_date')) {
    suggestions.push(
      suggestion(
        input.column,
        ['parse_date_us'],
        usDateRate,
        strings,
        'Parse US MM/DD/YYYY dates',
        {
          parseableDateRate: usDateRate,
        }
      )
    );
  } else if (euDateRate >= 0.8 && !columnName.endsWith('_at') && !columnName.endsWith('_date')) {
    suggestions.push(
      suggestion(
        input.column,
        ['parse_date_eu'],
        euDateRate,
        strings,
        'Parse EU DD/MM/YYYY dates',
        {
          parseableDateRate: euDateRate,
        }
      )
    );
  } else if (
    parseableDateRate >= 0.8 &&
    !columnName.endsWith('_at') &&
    !columnName.endsWith('_date')
  ) {
    suggestions.push(
      suggestion(
        input.column,
        ['parse_dates'],
        parseableDateRate,
        strings,
        'Parse date-like strings into typed dates',
        {
          parseableDateRate,
        }
      )
    );
  }
  if ((columnName === 'state' || columnName.endsWith('_state')) && stateRate >= 0.6) {
    suggestions.push(
      suggestion(
        input.column,
        ['normalize_state'],
        stateRate,
        strings,
        'Normalize US state names and abbreviations',
        {
          stateRate,
        }
      )
    );
  }

  return suggestions.sort(
    (a, b) => b.confidence - a.confidence || a.column.localeCompare(b.column)
  );
}

export function suggestCleaning(input: SuggestCleaningInput): CleaningSuggestion[] {
  return input.columns.flatMap((column) =>
    suggestCleaningForColumn({ column: column.name, values: column.values })
  );
}

function quoteModelColumnRef(column: string): string {
  return /^[a-zA-Z_]\w*$/.test(column) ? column : `"${column.replace(/"/g, '""')}"`;
}

function transformsToModelExpr(
  column: string,
  transforms: CleaningSuggestion['transforms']
): string | null {
  if (transforms.length === 0) return null;
  let expr: string = quoteModelColumnRef(column);
  for (const transform of transforms) {
    switch (transform) {
      case 'lowercase':
        expr = `lower(${expr})`;
        break;
      case 'uppercase':
        expr = `upper(${expr})`;
        break;
      case 'trim':
        expr = `trim(${expr})`;
        break;
      case 'strip_protocol':
      case 'strip_www':
        if (!expr.startsWith('strip_www(')) {
          expr = `strip_www(${expr})`;
        }
        break;
      case 'parse_dates':
        expr = `parse_date(${expr}, 'iso8601')`;
        break;
      case 'parse_date_us':
        expr = `parse_date(${expr}, 'us')`;
        break;
      case 'parse_date_eu':
        expr = `parse_date(${expr}, 'eu')`;
        break;
      default:
        expr = `${transform}(${expr})`;
        break;
    }
  }
  return expr;
}

function suggestion(
  column: string,
  transforms: CleaningSuggestion['transforms'],
  rateValue: number,
  values: string[],
  rationale: string,
  evidence: ProfileEvidence
): CleaningSuggestion {
  return {
    column,
    transforms,
    model_expr: transformsToModelExpr(column, transforms),
    confidence: clampConfidence(0.45 + Math.min(rateValue, 1) * 0.5),
    evidence: {
      sampleSize: values.length,
      examples: sampleExamples(values),
      ...evidence,
    },
    rationale,
  };
}

function rate(values: string[], predicate: (value: string) => boolean): number {
  if (values.length === 0) return 0;
  return roundRate(values.filter(predicate).length / values.length);
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}
