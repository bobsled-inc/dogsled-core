import type { StandardizeFunction } from './types.js';

export type EntityTypeHint = 'company' | 'person' | 'account' | 'contact' | 'unknown';

export interface ResourceSchemaColumn {
  name: string;
  type?: string;
}

export interface ResourceSchema {
  name?: string;
  columns: ResourceSchemaColumn[];
}

export interface StandardizeRule {
  field: string;
  transforms: StandardizeFunction[];
}

export interface EntityDetectionAnalysis {
  entityType: EntityTypeHint;
  confidence: number;
  reviewMarkers: string[];
  idFields: string[];
  standardizeRules: StandardizeRule[];
}

const COMPANY_FIELD_NAMES = ['company_name', 'account_name', 'organization', 'org_name'] as const;
const PERSON_FIELD_NAMES = ['first_name', 'last_name', 'given_name', 'family_name'] as const;
const DOMAIN_FIELD_NAMES = ['domain', 'website', 'web_site', 'company_domain'] as const;
const EMAIL_FIELD_NAMES = ['email', 'email_address'] as const;
const PHONE_FIELD_NAMES = ['phone', 'phone_number', 'mobile', 'mobile_phone'] as const;
const PERSON_RESOURCE_NAMES = ['person', 'contact', 'lead', 'user'] as const;
const COMPANY_RESOURCE_NAMES = ['company', 'account', 'organization', 'org', 'business'] as const;
const IRREGULAR_SINGULAR_RESOURCE_TOKENS: Record<string, string> = {
  children: 'child',
  feet: 'foot',
  men: 'man',
  mice: 'mouse',
  people: 'person',
  teeth: 'tooth',
  women: 'woman',
};

export function detectEntityType(schema: ResourceSchema): EntityTypeHint {
  const analysis = analyzeEntitySchema(schema);
  return analysis.entityType;
}

export function detectIdFields(schema: ResourceSchema): string[] {
  const seen = new Set<string>();
  const idFields: string[] = [];
  const resourceIdCandidates = buildResourceIdCandidates(schema);

  for (const column of schema.columns) {
    const normalized = normalizeFieldName(column.name);
    if (normalized === 'id' || resourceIdCandidates.has(normalized)) {
      if (!seen.has(column.name)) {
        seen.add(column.name);
        idFields.push(column.name);
      }
    }
  }

  return idFields;
}

export function suggestStandardizeRules(
  fields: string[],
  entityType: EntityTypeHint
): StandardizeRule[] {
  const rules: StandardizeRule[] = [];

  for (const field of fields) {
    const normalized = normalizeFieldName(field);
    let transforms: StandardizeFunction[] | undefined;

    if (DOMAIN_FIELD_NAMES.includes(normalized as (typeof DOMAIN_FIELD_NAMES)[number])) {
      transforms = ['strip_www', 'strip_protocol', 'lowercase'];
    } else if (COMPANY_FIELD_NAMES.includes(normalized as (typeof COMPANY_FIELD_NAMES)[number])) {
      transforms = ['strip_legal_suffixes', 'lowercase', 'collapse_whitespace'];
    } else if (EMAIL_FIELD_NAMES.includes(normalized as (typeof EMAIL_FIELD_NAMES)[number])) {
      transforms = ['lowercase', 'trim'];
    } else if (
      PERSON_FIELD_NAMES.includes(normalized as (typeof PERSON_FIELD_NAMES)[number]) ||
      (entityType === 'person' && normalized === 'name')
    ) {
      transforms = ['lowercase', 'trim', 'collapse_whitespace'];
    }

    if (transforms) {
      rules.push({ field, transforms });
    }
  }

  return deduplicateRules(rules);
}

export function analyzeEntitySchema(schema: ResourceSchema): EntityDetectionAnalysis {
  const normalizedColumns = schema.columns.map((column) => ({
    original: column.name,
    normalized: normalizeFieldName(column.name),
  }));
  const fieldNames = new Set(normalizedColumns.map((column) => column.normalized));
  const resourceName = normalizeFieldName(schema.name ?? '');
  const reviewMarkers: string[] = [];
  const idFields = detectIdFields(schema);
  const ambiguousIdFields = collectAmbiguousIdFields(schema, idFields);

  if (schema.columns.length === 0) {
    reviewMarkers.push('REVIEW: schema inference returned no columns');
    return {
      entityType: 'unknown',
      confidence: 0,
      reviewMarkers,
      idFields,
      standardizeRules: [],
    };
  }

  if (idFields.length === 0) {
    reviewMarkers.push('REVIEW: no primary key detected');
  }
  if (ambiguousIdFields.length > 0) {
    reviewMarkers.push(
      `REVIEW: additional *_id fields may be foreign keys; confirm source identity columns: ${ambiguousIdFields.join(', ')}`
    );
  }

  const hasDomain = intersects(fieldNames, DOMAIN_FIELD_NAMES);
  const hasEmail = intersects(fieldNames, EMAIL_FIELD_NAMES);
  const hasPersonName = intersects(fieldNames, PERSON_FIELD_NAMES);
  const hasCompanyName = intersects(fieldNames, COMPANY_FIELD_NAMES);
  const hasPhoneOnly =
    !hasDomain && !hasEmail && !hasPersonName && !hasCompanyName
      ? intersects(fieldNames, PHONE_FIELD_NAMES)
      : false;

  if (hasDomain && hasEmail && !hasCompanyName && !hasPersonName) {
    reviewMarkers.push(
      'REVIEW: both email and domain are present without a clear entity label; confirm company vs person'
    );
  }

  if (hasPersonName && hasCompanyName) {
    reviewMarkers.push(
      'REVIEW: both person-name and company-name fields are present; confirm which entity this resource represents'
    );
  }

  const entityType = inferEntityType({
    hasDomain,
    hasEmail,
    hasPersonName,
    hasCompanyName,
    hasPhoneOnly,
    resourceName,
  });
  const confidence = inferConfidence(entityType, reviewMarkers);

  return {
    entityType,
    confidence,
    reviewMarkers,
    idFields,
    standardizeRules: suggestStandardizeRules(
      normalizedColumns.map((column) => column.original),
      entityType
    ),
  };
}

function inferEntityType(input: {
  hasDomain: boolean;
  hasEmail: boolean;
  hasPersonName: boolean;
  hasCompanyName: boolean;
  hasPhoneOnly: boolean;
  resourceName: string;
}): EntityTypeHint {
  const resourceLooksPerson = PERSON_RESOURCE_NAMES.some((token) =>
    input.resourceName.includes(token)
  );
  const resourceLooksCompany = COMPANY_RESOURCE_NAMES.some((token) =>
    input.resourceName.includes(token)
  );

  if (input.hasPhoneOnly) {
    return 'unknown';
  }

  if (input.hasPersonName && input.hasCompanyName) {
    if (resourceLooksPerson) {
      return 'contact';
    }
    if (resourceLooksCompany) {
      return 'account';
    }
    return 'unknown';
  }

  if (input.hasDomain && !input.hasEmail) {
    return resourceLooksCompany ? 'account' : 'company';
  }

  if (input.hasEmail && !input.hasCompanyName && !input.hasDomain) {
    return resourceLooksPerson ? 'contact' : 'person';
  }

  if (input.hasEmail && input.hasCompanyName) {
    return resourceLooksCompany ? 'account' : 'company';
  }

  if (input.hasPersonName) {
    return resourceLooksPerson ? 'contact' : 'person';
  }

  if (input.hasCompanyName) {
    return resourceLooksCompany ? 'account' : 'company';
  }

  return 'unknown';
}

function inferConfidence(entityType: EntityTypeHint, reviewMarkers: string[]): number {
  if (entityType === 'unknown') {
    return 0.35;
  }
  if (reviewMarkers.length > 0) {
    return 0.7;
  }
  if (entityType === 'account' || entityType === 'contact') {
    return 0.8;
  }
  return 0.95;
}

function buildResourceIdCandidates(schema: ResourceSchema): Set<string> {
  const resourceName = normalizeFieldName(schema.name ?? '');
  const candidates = new Set<string>();
  if (!resourceName) {
    return candidates;
  }

  const resourceTokens = resourceName.split('_').filter(Boolean);
  const singularResourceName = singularizeResourceToken(resourceName);
  const singularLastToken = singularizeResourceToken(
    resourceTokens[resourceTokens.length - 1] ?? ''
  );

  if (singularResourceName) {
    candidates.add(`${singularResourceName}_id`);
  }
  if (singularLastToken) {
    candidates.add(`${singularLastToken}_id`);
  }

  return candidates;
}

function collectAmbiguousIdFields(schema: ResourceSchema, idFields: string[]): string[] {
  const selectedFields = new Set(idFields.map((field) => normalizeFieldName(field)));

  return schema.columns
    .filter((column) => {
      const normalized = normalizeFieldName(column.name);
      return normalized !== 'id' && normalized.endsWith('_id') && !selectedFields.has(normalized);
    })
    .map((column) => column.name);
}

function singularizeResourceToken(value: string): string {
  if (!value) {
    return value;
  }
  const irregularSingular = IRREGULAR_SINGULAR_RESOURCE_TOKENS[value];
  if (irregularSingular) {
    return irregularSingular;
  }
  if (value.endsWith('ies') && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith('sses') && value.length > 4) {
    return value.slice(0, -2);
  }
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 1) {
    return value.slice(0, -1);
  }
  return value;
}

export function normalizeFieldName(value: string): string {
  return value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function intersects(values: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function deduplicateRules(rules: StandardizeRule[]): StandardizeRule[] {
  const seen = new Set<string>();
  const deduplicated: StandardizeRule[] = [];

  for (const rule of rules) {
    const key = `${rule.field}:${rule.transforms.join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduplicated.push(rule);
  }

  return deduplicated;
}
