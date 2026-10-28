import { isPlainObject } from '@/lib/guards';

interface ClusterDetailObject {
  [key: string]: unknown;
}

export interface ClusterDetailFieldValue {
  key: string;
  label: string;
  value: string | null;
}

export interface ClusterDetailBusinessCard {
  label: string;
  value: string;
  context?: string;
}

export interface ClusterDetailProfile {
  cluster_id: string;
  display_name: string | null;
  source_count: number;
  record_count: number;
  trust_tier: string | null;
  entity_trust_score: number | null;
  identity_confidence: number | null;
  freshness_score: number | null;
}

export interface ClusterDetailMember {
  record_id: string;
  source_ref: string | null;
  source_system: string;
  source_entity_id: string | null;
  confidence_score: number | null;
  matched_at: string | null;
  member_fields: ClusterDetailFieldValue[];
}

export interface ClusterDetailGoldenRow {
  attribute_name: string;
  attribute_label: string | null;
  attribute_value: string | null;
  source_system: string | null;
  updated_at: string | null;
}

export interface ClusterDetailAuditRow {
  attribute_name: string;
  chosen_value: string | null;
  source_system: string | null;
  strategy: string | null;
  decided_at: string | null;
}

export interface ClusterDetailPayload {
  cluster_id: string;
  scenario?: string;
  entity: string;
  profile: ClusterDetailProfile;
  members: ClusterDetailMember[];
  golden_record: ClusterDetailGoldenRow[];
  survivorship_audit: ClusterDetailAuditRow[];
  business_snapshot: ClusterDetailBusinessCard[];
}

function invalidClusterDetail(field: string): never {
  throw new Error(`Invalid cluster detail response: ${field}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalidClusterDetail(field);
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') invalidClusterDetail(field);
  return value;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidClusterDetail(field);
  return value;
}

function readNullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidClusterDetail(field);
  return value;
}

function readObject(value: unknown, field: string): ClusterDetailObject {
  if (!isPlainObject(value)) invalidClusterDetail(field);
  return value;
}

function readArray<T>(
  value: unknown,
  field: string,
  parseItem: (item: unknown, itemField: string) => T
): T[] {
  if (!Array.isArray(value)) invalidClusterDetail(field);
  return value.map((item, index) => parseItem(item, `${field}[${index}]`));
}

function parseFieldValue(value: unknown, field: string): ClusterDetailFieldValue {
  const record = readObject(value, field);
  return {
    key: readString(record.key, `${field}.key`),
    label: readString(record.label, `${field}.label`),
    value: readNullableString(record.value, `${field}.value`),
  };
}

function parseBusinessCard(value: unknown, field: string): ClusterDetailBusinessCard {
  const record = readObject(value, field);
  return {
    label: readString(record.label, `${field}.label`),
    value: readString(record.value, `${field}.value`),
    context:
      record.context === undefined
        ? undefined
        : (readNullableString(record.context, `${field}.context`) ?? undefined),
  };
}

function parseProfile(value: unknown, field: string): ClusterDetailProfile {
  const record = readObject(value, field);

  return {
    cluster_id: readString(record.cluster_id, `${field}.cluster_id`),
    display_name: readNullableString(record.display_name, `${field}.display_name`),
    source_count: readNumber(record.source_count, `${field}.source_count`),
    record_count: readNumber(record.record_count, `${field}.record_count`),
    trust_tier: readNullableString(record.trust_tier, `${field}.trust_tier`),
    entity_trust_score: readNullableNumber(
      record.entity_trust_score,
      `${field}.entity_trust_score`
    ),
    identity_confidence: readNullableNumber(
      record.identity_confidence,
      `${field}.identity_confidence`
    ),
    freshness_score: readNullableNumber(record.freshness_score, `${field}.freshness_score`),
  };
}

function parseMember(value: unknown, field: string): ClusterDetailMember {
  const record = readObject(value, field);

  return {
    record_id: readString(record.record_id, `${field}.record_id`),
    source_ref: readNullableString(record.source_ref, `${field}.source_ref`),
    source_system: readString(record.source_system, `${field}.source_system`),
    source_entity_id: readNullableString(record.source_entity_id, `${field}.source_entity_id`),
    confidence_score: readNullableNumber(record.confidence_score, `${field}.confidence_score`),
    matched_at: readNullableString(record.matched_at, `${field}.matched_at`),
    member_fields: readArray(record.member_fields, `${field}.member_fields`, parseFieldValue),
  };
}

function parseGoldenRow(value: unknown, field: string): ClusterDetailGoldenRow {
  const record = readObject(value, field);

  return {
    attribute_name: readString(record.attribute_name, `${field}.attribute_name`),
    attribute_label: readNullableString(record.attribute_label, `${field}.attribute_label`),
    attribute_value: readNullableString(record.attribute_value, `${field}.attribute_value`),
    source_system: readNullableString(record.source_system, `${field}.source_system`),
    updated_at: readNullableString(record.updated_at, `${field}.updated_at`),
  };
}

function parseAuditRow(value: unknown, field: string): ClusterDetailAuditRow {
  const record = readObject(value, field);

  return {
    attribute_name: readString(record.attribute_name, `${field}.attribute_name`),
    chosen_value: readNullableString(record.chosen_value, `${field}.chosen_value`),
    source_system: readNullableString(record.source_system, `${field}.source_system`),
    strategy: readNullableString(record.strategy, `${field}.strategy`),
    decided_at: readNullableString(record.decided_at, `${field}.decided_at`),
  };
}

export function parseClusterDetailPayload(value: unknown): ClusterDetailPayload {
  const record = readObject(value, 'response');
  const scenario =
    record.scenario === undefined ? undefined : readNullableString(record.scenario, 'scenario');

  return {
    cluster_id: readString(record.cluster_id, 'cluster_id'),
    scenario: scenario ?? undefined,
    entity: readString(record.entity, 'entity'),
    profile: parseProfile(record.profile, 'profile'),
    members: readArray(record.members, 'members', parseMember),
    golden_record: readArray(record.golden_record, 'golden_record', parseGoldenRow),
    survivorship_audit: readArray(record.survivorship_audit, 'survivorship_audit', parseAuditRow),
    business_snapshot: readArray(record.business_snapshot, 'business_snapshot', parseBusinessCard),
  };
}
