import {
  USPS_DIRECTIONALS,
  USPS_SECONDARY_UNIT_DESIGNATORS,
  USPS_STREET_SUFFIXES,
} from '@bobsled-inc/model-spec';
import { createHash } from 'node:crypto';
import { CommandError } from '@bobsled-inc/protocol';

import type {
  ResolvedResolutionSpec,
  StandardizeFunction,
  StandardizeTransform,
} from '../../compiler/identity/types.js';

export type StandardizedValue = string | number | null;
export type StandardizedFields = Record<string, StandardizedValue>;

const LEGAL_SUFFIX_PATTERN =
  /(?:^|\s+|,\s*)(inc\.?|incorporated|llc\.?|l\.l\.c\.?|ltd\.?|limited|corp\.?|corporation|company|co\.?)$/i;

const TRADING_AS_PATTERN = /\s+(?:d\s*\/\s*b\s*\/\s*a|dba|trading\s+as|t\s*\/\s*a)\s+.*$/i;

const US_STATE_NAMES = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
] as const;

const US_STATE_PAIRS = US_STATE_NAMES.flatMap(([code, name]) => [
  [code, code],
  [name.toUpperCase(), code],
]) as Array<[string, string]>;

const US_STATES = new Map(US_STATE_PAIRS);

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function stripAccents(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 's')
    .replace(/Æ/g, 'A')
    .replace(/æ/g, 'a')
    .replace(/Œ/g, 'O')
    .replace(/œ/g, 'o');
}

function stripCountryCode(value: string): string {
  return value.length === 11 && value.startsWith('1') ? value.slice(1) : value;
}

function tokenPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b(?:${escaped})\\b`, 'gi');
}

function addressGroups(): Array<{ canonical: string; patterns: RegExp[]; maxLength: number }> {
  return Object.entries({
    ...USPS_STREET_SUFFIXES,
    ...USPS_SECONDARY_UNIT_DESIGNATORS,
    ...USPS_DIRECTIONALS,
  } as Record<string, readonly string[]>)
    .map(([canonical, variants]) => {
      const allVariants = Array.from(new Set([canonical, ...variants]));
      return {
        canonical,
        patterns: allVariants.map(tokenPattern),
        maxLength: Math.max(...allVariants.map((variant) => variant.length)),
      };
    })
    .sort((a, b) => b.maxLength - a.maxLength || b.canonical.length - a.canonical.length);
}

const ADDRESS_GROUPS = addressGroups();

function expandStreetAbbreviations(value: string): string {
  let result = value;
  for (const group of ADDRESS_GROUPS) {
    for (const pattern of group.patterns) {
      result = result.replace(pattern, group.canonical);
    }
  }
  return result;
}

function normalizeStreet(value: string): string {
  const collapsed = value
    .toLowerCase()
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ');
  return expandStreetAbbreviations(collapsed).trim();
}

function normalizePostal(value: string): string {
  const normalized = value.toUpperCase().trim();
  if (/^[0-9]{5}-?[0-9]{4}$/.test(normalized)) {
    return normalized.replace(/[^0-9]/g, '').slice(0, 5);
  }
  return normalized.replace(/[\s-]+/g, '');
}

function normalizeCompany(value: string): string {
  return value.trim().replace(LEGAL_SUFFIX_PATTERN, '').toLowerCase().replace(/\s+/g, ' ');
}

function fingerprint(value: string): string {
  const cleaned = stripAccents(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
  return Array.from(new Set(cleaned.split(' ').filter((token) => token.length > 0)))
    .sort()
    .join(' ');
}

function parseNumber(value: string): number | null {
  const parsed = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readMatchKeySecret(): string {
  const secret = process.env.BOBSLED_CORE_MATCH_KEY_SECRET;
  if (!secret) {
    throw new CommandError(
      'BOBSLED_CORE_MATCH_KEY_SECRET is required when hmac_sha256 standardize transforms are used.',
      2
    );
  }
  return secret;
}

function keyedDoubleSha256(value: string): string {
  const key = readMatchKeySecret();
  return sha256Hex(`${key}${sha256Hex(`${key}${value}`)}`);
}

function normalizeEmailUid2(value: string): string {
  const normalized = value.trim().toLowerCase();
  const atIndex = normalized.indexOf('@');
  if (atIndex < 0) return normalized;
  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\+.*$/u, '').replace(/\./gu, '')}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export function applyStandardizeFunction(
  value: StandardizedValue,
  transform: StandardizeFunction
): StandardizedValue {
  if (value === null) return null;
  const stringValue = String(value);
  switch (transform) {
    case 'lowercase':
      return stringValue.toLowerCase();
    case 'uppercase':
      return stringValue.toUpperCase();
    case 'trim':
      return stringValue.trim();
    case 'collapse_whitespace':
      return stringValue.replace(/\s+/g, ' ');
    case 'nullif_empty': {
      const trimmed = stringValue.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    case 'normalize_email':
      return stringValue.trim().toLowerCase();
    case 'normalize_email_uid2':
      return normalizeEmailUid2(stringValue);
    case 'extract_email_domain': {
      const atIndex = stringValue.indexOf('@');
      return atIndex >= 0 ? stringValue.slice(atIndex + 1) : '';
    }
    case 'strip_email_subaddress':
      return stringValue.replace(/\+[^@]*/g, '');
    case 'strip_accents':
      return stripAccents(stringValue);
    case 'strip_legal_suffixes':
      return stringValue.replace(LEGAL_SUFFIX_PATTERN, '');
    case 'strip_trading_as':
      return stringValue.replace(TRADING_AS_PATTERN, '');
    case 'normalize_company':
      return normalizeCompany(stringValue);
    case 'strip_www':
    case 'strip_protocol':
      return stringValue.replace(/^(?:https?:\/\/(?:www\.)?|www\.)/i, '');
    case 'extract_domain':
      return stringValue.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/[/?#].*$/, '');
    case 'digits_only':
      return stringValue.replace(/[^0-9]/g, '');
    case 'strip_country_code':
      return stripCountryCode(stringValue);
    case 'strip_phone_extension':
      return stringValue.replace(/\s*(?:ext\.?|extension|x)\s*#?\s*\d+\s*$/i, '');
    case 'normalize_phone':
      return stripCountryCode(stringValue.replace(/[^0-9]/g, ''));
    case 'normalize_state': {
      const normalized = stringValue.trim().toUpperCase();
      return US_STATES.get(normalized) ?? normalized;
    }
    case 'expand_street_abbreviations':
      return expandStreetAbbreviations(stringValue);
    case 'normalize_street':
      return normalizeStreet(stringValue);
    case 'normalize_postal':
      return normalizePostal(stringValue);
    case 'remove_punctuation':
      return stringValue.replace(/[^a-zA-Z0-9 ]/g, '');
    case 'fingerprint':
      return fingerprint(stringValue);
    case 'parse_number':
      return parseNumber(stringValue);
    case 'sha256':
      return sha256Hex(stringValue);
    case 'hmac_sha256':
      return keyedDoubleSha256(stringValue);
  }
}

export function applyTransformChain(
  value: unknown,
  transforms: readonly StandardizeFunction[]
): StandardizedValue {
  let current: StandardizedValue = toNullableString(value);
  for (const transform of transforms) {
    current = applyStandardizeFunction(current, transform);
  }
  return current;
}

export function applyStandardizeTransforms(
  fields: Record<string, unknown>,
  specOrTransforms: ResolvedResolutionSpec | readonly StandardizeTransform[]
): StandardizedFields {
  const transforms =
    'standardize' in specOrTransforms ? specOrTransforms.standardize : specOrTransforms;
  return Object.fromEntries(
    transforms.map((transform) => [
      `standardized_${transform.field}`,
      transform.preHashed
        ? toNullableString(fields[transform.field])
        : applyTransformChain(fields[transform.field], transform.transforms),
    ])
  );
}
