export type ProfileScalarKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'date'
  | 'array'
  | 'object'
  | 'null'
  | 'mixed';

export type ProfileFormatKind = 'email' | 'phone' | 'url' | 'iso8601' | 'uuid' | 'mixed' | null;

export type ProfileSemanticRole =
  | 'entity_id'
  | 'measure'
  | 'event_timestamp'
  | 'extraction_timestamp'
  | 'time_dimension'
  | 'categorical'
  | 'identifier'
  | 'name'
  | 'address'
  | 'email'
  | 'phone'
  | 'url'
  | 'currency'
  | 'count'
  | 'rate';

export interface ProfileEvidence {
  [field: string]: unknown;
}

export interface ProfileSampleRow {
  [columnName: string]: unknown;
}

export interface ProfileInference<TKind> {
  kind: TKind;
  confidence: number;
  evidence: ProfileEvidence;
}

export interface ProfileHistogramBucket {
  value: string;
  count: number;
  rate: number;
}

export type ProfileAnomalyType = 'mixed_types' | 'inconsistent_casing' | 'parseable_subfields';

export type ProfileAnomalySeverity = 'low' | 'medium' | 'high';

export interface ProfileAnomaly {
  type: ProfileAnomalyType;
  severity: ProfileAnomalySeverity;
  examples: unknown[];
  evidence: ProfileEvidence;
}

export interface ProfileColumn {
  name: string;
  dataType: string;
  nullRate: number;
  distinctCount: number;
  distinctRate: number;
  valueDistribution: ProfileHistogramBucket[];
  typeInference: ProfileInference<ProfileScalarKind> | null;
  formatInference: ProfileInference<ProfileFormatKind> | null;
  semanticRoleInference: ProfileInference<ProfileSemanticRole | null> | null;
  anomalies: ProfileAnomaly[];
}

export type CleaningTransform =
  | 'lowercase'
  | 'uppercase'
  | 'trim'
  | 'collapse_whitespace'
  | 'nullif_empty'
  | 'normalize_email'
  | 'extract_email_domain'
  | 'strip_email_subaddress'
  | 'strip_accents'
  | 'strip_legal_suffixes'
  | 'strip_trading_as'
  | 'normalize_company'
  | 'strip_www'
  | 'strip_protocol'
  | 'extract_domain'
  | 'digits_only'
  | 'strip_country_code'
  | 'strip_phone_extension'
  | 'normalize_phone'
  | 'normalize_state'
  | 'remove_punctuation'
  | 'fingerprint'
  | 'parse_number'
  | 'parse_dates'
  | 'parse_date_us'
  | 'parse_date_eu';

export interface CleaningSuggestion {
  column: string;
  transforms: CleaningTransform[];
  /** Model Spec model column expression using cleaning primitives (e.g. `lower(trim(email))`). Null when no direct Model Spec mapping exists. */
  model_expr: string | null;
  confidence: number;
  evidence: ProfileEvidence;
  rationale: string;
}

export interface PrimaryKeyCandidate {
  columns: string[];
  uniqueness: number;
  confidence: number;
  recommendation: 'primary_key' | 'review' | 'not_recommended';
  evidence: ProfileEvidence;
}

export interface ForeignKeyCandidate {
  from: string;
  toTable: string;
  toColumn: string;
  hitRate: number;
  confidence: number;
  evidence: ProfileEvidence;
}

export interface ProfileReport {
  table: string;
  rowCount: number;
  sampleSize: number;
  columns: ProfileColumn[];
  pkCandidates: PrimaryKeyCandidate[];
  fkCandidates: ForeignKeyCandidate[];
  cleaningSuggestions: CleaningSuggestion[];
}

export interface ProfileColumnInput {
  name: string;
  dataType?: string;
}

export interface ForeignKeyTarget {
  table: string;
  column: string;
  values: unknown[];
  uniqueness?: number;
}

export interface ProfileBuildInput {
  table: string;
  rows: ProfileSampleRow[];
  rowCount: number;
  columns?: ProfileColumnInput[];
  foreignKeyTargets?: ForeignKeyTarget[];
}
