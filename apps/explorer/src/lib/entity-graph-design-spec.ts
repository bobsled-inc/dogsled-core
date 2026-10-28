export interface ResolutionInput {
  ref: string;
  role?: string;
  trust_tier?: string;
  id_fields?: string[];
}

export interface StandardizeRule {
  field: string;
  // The wizard accepts custom transforms beyond the browser preview allowlist,
  // so this remains open-ended instead of narrowing to KNOWN_TRANSFORMS only.
  transforms: string[];
}

export interface BlockingRule {
  name: string;
  key: string;
}

export interface BlockingConfig {
  rules?: BlockingRule[];
  candidate_limit?: number;
}

export interface ScoringFeature {
  field: string;
  algorithm: string;
  weight: number;
}

export interface ScoringConfig {
  method?: string;
  features?: ScoringFeature[];
}

export interface ResolutionThresholds {
  auto_merge?: number;
  review?: number;
  auto_reject?: number;
}

export interface ResolutionSpec {
  spec_version?: string;
  name?: string;
  type?: string;
  description?: string;
  inputs?: ResolutionInput[];
  standardize?: StandardizeRule[];
  blocking?: BlockingConfig;
  scoring?: ScoringConfig;
  thresholds?: ResolutionThresholds;
  [key: string]: unknown;
}

export const KNOWN_ALGORITHMS = [
  'jaro_winkler',
  'exact',
  'numeric_distance',
  'edit_distance',
  'soundex',
  'date_proximity',
] as const;

export const KNOWN_TRANSFORMS = [
  'lowercase',
  'uppercase',
  'trim',
  'collapse_whitespace',
  'strip_legal_suffixes',
  'strip_protocol',
  'strip_www',
  'digits_only',
  'strip_country_code',
  'remove_punctuation',
] as const;
