import { ENTITY_GRAPH_DEFAULT_ENTITY } from './entity-graph-constants';
import { SCENARIO_DEFINITIONS, SCENARIO_ENTITIES } from './entity-graph-scenario-catalog';

export type EntityGraphScenarioId = 'default';
export type EntityGraphEntityId = 'company' | 'customer' | 'location';
export type EntityGraphValueFormat = 'text' | 'currency' | 'number' | 'datetime';

export interface EntityGraphCompareFieldDefinition {
  key: string;
  label: string;
  column: string;
  scoreKey?: string;
  format?: EntityGraphValueFormat;
}

export interface EntityGraphMemberFieldDefinition {
  key: string;
  label: string;
  column: string;
  format?: EntityGraphValueFormat;
}

export interface EntityGraphCompareFieldValue {
  key: string;
  label: string;
  a: string | null;
  b: string | null;
}

export interface EntityGraphFeatureContribution {
  key: string;
  label: string;
  score: number | null;
  a: string | null;
  b: string | null;
}

export interface EntityGraphMemberFieldValue {
  key: string;
  label: string;
  value: string | null;
}

export interface EntityGraphBusinessInsightCard {
  label: string;
  value: string;
  context?: string;
}

export interface EntityGraphHeroExample {
  id: string;
  entity: EntityGraphEntityId;
  kind: 'queue' | 'cluster';
  title: string;
  description: string;
  href: string;
  ctaLabel?: string;
}

export interface EntityGraphEntityDefinition {
  id: EntityGraphEntityId;
  label: string;
  singularLabel: string;
  pluralLabel: string;
  description: string;
  defaultResolutionSpec: string;
  defaultSurvivorshipSpec: string;
  compareFields: EntityGraphCompareFieldDefinition[];
  memberFields: EntityGraphMemberFieldDefinition[];
  goldenRecordLabels?: Record<string, string>;
}

export interface EntityGraphScenarioDefinition {
  id: EntityGraphScenarioId;
  label: string;
  shortLabel: string;
  description: string;
  workspaceDir: string;
  schema: string;
  defaultEntity: EntityGraphEntityId;
  supportedEntities: EntityGraphEntityId[];
  landingKpis: EntityGraphBusinessInsightCard[];
  heroExamples: EntityGraphHeroExample[];
}

interface EntityGraphSearchLike {
  get(name: string): string | null;
}

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function readStringValue(value: unknown, format: EntityGraphValueFormat = 'text'): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return formatEntityGraphValue(value, format);
  }
  if (typeof value === 'bigint') {
    return formatEntityGraphValue(value.toString(), format);
  }
  if (typeof value === 'string') {
    return formatEntityGraphValue(value, format);
  }
  return String(value);
}

function findEntityByScoreKey(
  entity: EntityGraphEntityDefinition,
  scoreKey: string
): EntityGraphCompareFieldDefinition | null {
  return entity.compareFields.find((field) => field.scoreKey === scoreKey) ?? null;
}

function getCompareFieldOrder(entity: EntityGraphEntityDefinition, key: string): number {
  const index = entity.compareFields.findIndex((field) => field.key === key);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function readNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatUtcDate(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readDateValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatUtcDate(parsed);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function parseFieldDiffs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return parseObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function formatEntityGraphValue(
  value: unknown,
  format: EntityGraphValueFormat = 'text'
): string | null {
  if (value === null || value === undefined || value === '') return null;

  switch (format) {
    case 'currency': {
      const numeric = readNumericValue(value);
      return numeric === null
        ? String(value)
        : new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0,
          }).format(numeric);
    }
    case 'number': {
      const numeric = readNumericValue(value);
      return numeric === null ? String(value) : NUMBER_FORMATTER.format(numeric);
    }
    case 'datetime':
      return readDateValue(value);
    case 'text':
    default:
      return String(value);
  }
}

export function isEntityGraphScenarioId(value: unknown): value is EntityGraphScenarioId {
  return value === 'default';
}

export function isEntityGraphEntityId(value: unknown): value is EntityGraphEntityId {
  return value === 'company' || value === 'customer' || value === 'location';
}

export function isInvalidEntityGraphInputError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message.startsWith('Unsupported Entity Graph scenario "') ||
      err.message.startsWith('Unsupported Entity Graph entity "'))
  );
}

export function listEntityGraphScenarioDefinitions(): EntityGraphScenarioDefinition[] {
  return Object.values(SCENARIO_DEFINITIONS);
}

export function getEntityGraphScenarioDefinition(
  scenarioId: EntityGraphScenarioId = 'default'
): EntityGraphScenarioDefinition {
  const scenario = SCENARIO_DEFINITIONS[scenarioId];
  if (!scenario) throw new Error(`Unsupported Entity Graph scenario "${scenarioId}"`);
  return scenario;
}

export function getEntityGraphEntityDefinition(
  entityId: EntityGraphEntityId
): EntityGraphEntityDefinition {
  return SCENARIO_ENTITIES[entityId];
}

export function resolveEntityGraphScenarioEntity(
  scenarioValue?: string | null,
  entityValue?: string | null
): {
  scenarioId: EntityGraphScenarioId;
  scenario: EntityGraphScenarioDefinition;
  entityId: EntityGraphEntityId;
  entity: EntityGraphEntityDefinition;
} {
  let scenarioId: EntityGraphScenarioId = 'default';
  if (typeof scenarioValue === 'string' && scenarioValue.length > 0) {
    if (!isEntityGraphScenarioId(scenarioValue)) {
      throw new Error(`Unsupported Entity Graph scenario "${scenarioValue}"`);
    }
    scenarioId = scenarioValue;
  }
  const scenario = getEntityGraphScenarioDefinition(scenarioId);
  const requestedEntity =
    typeof entityValue === 'string' && entityValue.length > 0
      ? entityValue
      : scenario.defaultEntity;

  if (
    !isEntityGraphEntityId(requestedEntity) ||
    !scenario.supportedEntities.includes(requestedEntity)
  ) {
    throw new Error(
      `Unsupported Entity Graph entity "${requestedEntity}" for scenario "${scenarioId}"`
    );
  }

  return {
    scenarioId,
    scenario,
    entityId: requestedEntity,
    entity: getEntityGraphEntityDefinition(requestedEntity),
  };
}

export function findEntityGraphEntityByResolutionSpec(
  scenarioId: EntityGraphScenarioId,
  specName: string
): EntityGraphEntityDefinition | null {
  const scenario = getEntityGraphScenarioDefinition(scenarioId);
  for (const entityId of scenario.supportedEntities) {
    const entity = getEntityGraphEntityDefinition(entityId);
    if (entity.defaultResolutionSpec === specName) {
      return entity;
    }
  }
  return null;
}

export function readEntityGraphSelection(searchParams: EntityGraphSearchLike): {
  scenarioId: EntityGraphScenarioId;
  entityId: EntityGraphEntityId;
} {
  try {
    const { scenarioId, entityId } = resolveEntityGraphScenarioEntity(
      searchParams.get('scenario'),
      searchParams.get('entity')
    );
    return { scenarioId, entityId };
  } catch (err) {
    if (!isInvalidEntityGraphInputError(err)) {
      throw err;
    }
    return { scenarioId: 'default', entityId: 'company' };
  }
}

export function buildEntityGraphHref(
  pathname: string,
  options?: {
    scenario?: EntityGraphScenarioId | null;
    entity?: EntityGraphEntityId | null;
    params?: Record<string, string | null | undefined>;
  }
): string {
  const params = new URLSearchParams();

  if (options?.scenario && options.scenario !== 'default') {
    params.set('scenario', options.scenario);
  }
  if (options?.entity && options.entity !== ENTITY_GRAPH_DEFAULT_ENTITY) {
    params.set('entity', options.entity);
  }
  for (const [key, value] of Object.entries(options?.params ?? {})) {
    if (key === 'scenario' || key === 'entity') {
      continue;
    }
    if (value === null || value === undefined || value === '') {
      continue;
    }
    params.set(key, value);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getEntityGraphOverviewHref(
  scenarioId: EntityGraphScenarioId,
  _entityId?: EntityGraphEntityId
): string {
  getEntityGraphScenarioDefinition(scenarioId);
  return '/entity-graph';
}

export function buildEntityGraphCompareSelectList(
  entity: EntityGraphEntityDefinition,
  alias: string,
  prefix: 'a' | 'b'
): string[] {
  const quotedAlias = quoteSqlIdentifier(alias);
  return entity.compareFields.map(
    (field) =>
      `${quotedAlias}.${quoteSqlIdentifier(field.column)} AS ${quoteSqlIdentifier(`${prefix}_${field.key}`)}`
  );
}

export function buildEntityGraphMemberSelectList(
  entity: EntityGraphEntityDefinition,
  alias: string
): string[] {
  const quotedAlias = quoteSqlIdentifier(alias);
  return entity.memberFields.map(
    (field) =>
      `${quotedAlias}.${quoteSqlIdentifier(field.column)} AS ${quoteSqlIdentifier(field.key)}`
  );
}

export function buildEntityGraphCompareFields(
  entity: EntityGraphEntityDefinition,
  row: Record<string, unknown>
): EntityGraphCompareFieldValue[] {
  return entity.compareFields.map((field) => ({
    key: field.key,
    label: field.label,
    a: readStringValue(readValue(row, `a_${field.key}`), field.format),
    b: readStringValue(readValue(row, `b_${field.key}`), field.format),
  }));
}

export function buildEntityGraphFeatureContributions(
  entity: EntityGraphEntityDefinition,
  row: Record<string, unknown>
): EntityGraphFeatureContribution[] {
  const parsed = parseFieldDiffs(row.field_diffs);
  if (!parsed) return [];

  const contributions: EntityGraphFeatureContribution[] = [];
  for (const [scoreKey, rawScore] of Object.entries(parsed)) {
    const definition = findEntityByScoreKey(entity, scoreKey);
    const key = definition?.key ?? scoreKey.replace(/^standardized_/, '');
    const label = definition?.label ?? key.replaceAll('_', ' ');
    const format = definition?.format ?? 'text';
    contributions.push({
      key,
      label,
      score: readNumericValue(rawScore),
      a: readStringValue(readValue(row, `a_${key}`), format),
      b: readStringValue(readValue(row, `b_${key}`), format),
    });
  }

  return contributions.sort((left, right) => {
    return getCompareFieldOrder(entity, left.key) - getCompareFieldOrder(entity, right.key);
  });
}

export function buildEntityGraphMemberFields(
  entity: EntityGraphEntityDefinition,
  row: Record<string, unknown>
): EntityGraphMemberFieldValue[] {
  return entity.memberFields.map((field) => ({
    key: field.key,
    label: field.label,
    value: readStringValue(row[field.key], field.format),
  }));
}

export function labelEntityGraphGoldenAttribute(
  entity: EntityGraphEntityDefinition,
  attributeName: string
): string {
  return entity.goldenRecordLabels?.[attributeName] ?? attributeName.replaceAll('_', ' ');
}
