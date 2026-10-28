import type {
  ProfileEvidence,
  ProfileFormatKind,
  ProfileInference,
  ProfileScalarKind,
  ProfileSemanticRole,
} from '../types.js';

import { clampConfidence, normalizeName } from './utils.js';

export interface SemanticRoleInput {
  columnName: string;
  typeKind: ProfileScalarKind | null;
  formatKind: ProfileFormatKind;
  distinctRate: number;
}

export interface SemanticRoleEvidence extends ProfileEvidence {
  signal: string;
  distinctRate?: number;
  typeKind?: ProfileScalarKind | null;
}

export function inferSemanticRole(
  input: SemanticRoleInput
): ProfileInference<ProfileSemanticRole | null> {
  const name = normalizeName(input.columnName);
  const tokens = new Set(name.split('_').filter(Boolean));

  if (input.formatKind === 'email' || tokens.has('email')) {
    return role('email', 0.98, { signal: 'email_format_or_name' });
  }
  if (input.formatKind === 'phone' || tokens.has('phone') || tokens.has('mobile')) {
    return role('phone', 0.96, { signal: 'phone_format_or_name' });
  }
  if (
    input.formatKind === 'url' ||
    tokens.has('url') ||
    tokens.has('website') ||
    tokens.has('domain')
  ) {
    return role('url', 0.94, { signal: 'url_format_or_name' });
  }
  if (name === 'id' || name.endsWith('_id')) {
    const base = name === 'id' ? 0.92 : 0.82;
    const distinctnessPenalty =
      input.distinctRate < 0.6 ? 0.18 : input.distinctRate < 0.8 ? 0.08 : 0;
    return role(name === 'id' ? 'entity_id' : 'identifier', base - distinctnessPenalty, {
      signal: 'id_name',
      distinctRate: input.distinctRate,
    });
  }
  if (name === 'name' || name.endsWith('_name') || tokens.has('title') || tokens.has('label')) {
    return role('name', 0.86, { signal: 'name_token' });
  }
  if (tokens.has('address') || tokens.has('street') || tokens.has('city') || tokens.has('postal')) {
    return role('address', 0.82, { signal: 'address_token' });
  }
  if (
    name.endsWith('_at') ||
    name.endsWith('_timestamp') ||
    tokens.has('created') ||
    tokens.has('updated')
  ) {
    return role('event_timestamp', input.typeKind === 'timestamp' ? 0.92 : 0.76, {
      signal: 'timestamp_name',
      typeKind: input.typeKind,
    });
  }
  if (name.endsWith('_date') || input.typeKind === 'date') {
    return role('time_dimension', input.typeKind === 'date' ? 0.9 : 0.74, {
      signal: 'date_name',
      typeKind: input.typeKind,
    });
  }
  if (name.endsWith('_count') || tokens.has('count')) {
    return role('count', 0.88, { signal: 'count_name' });
  }
  if (
    name.endsWith('_amount') ||
    tokens.has('revenue') ||
    tokens.has('price') ||
    tokens.has('cost') ||
    tokens.has('currency')
  ) {
    return role(tokens.has('currency') ? 'currency' : 'measure', 0.84, { signal: 'money_name' });
  }
  if (
    name.endsWith('_rate') ||
    tokens.has('rate') ||
    tokens.has('ratio') ||
    tokens.has('percent')
  ) {
    return role('rate', 0.82, { signal: 'rate_name' });
  }
  if (tokens.has('status') || tokens.has('type') || tokens.has('category')) {
    return role('categorical', 0.78, { signal: 'categorical_name' });
  }

  return {
    kind: null,
    confidence: 0.35,
    evidence: { signal: 'no_semantic_role_signal' },
  };
}

function role(
  kind: ProfileSemanticRole,
  confidence: number,
  evidence: SemanticRoleEvidence
): ProfileInference<ProfileSemanticRole> {
  return { kind, confidence: clampConfidence(confidence), evidence };
}
