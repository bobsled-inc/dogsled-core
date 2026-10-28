const INVARIANT_WORDS = new Set([
  'status',
  'series',
  'species',
  'bus',
  'alias',
  'campus',
  'canvas',
]);

function singularizeSegment(segment: string): string {
  if (INVARIANT_WORDS.has(segment)) return segment;
  if (segment.endsWith('ies')) return `${segment.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(segment)) return segment.slice(0, -2);
  if (segment.endsWith('s') && !segment.endsWith('ss')) return segment.slice(0, -1);
  return segment;
}

export function singularizeName(name: string): string {
  const parts = name.split('_');
  const last = parts.pop() ?? name;
  return [...parts, singularizeSegment(last)].join('_');
}

export function rawSourceName(resourceName: string): string {
  return `raw_${resourceName}`;
}

export function stagingModelName(integrationName: string, resourceName: string): string {
  return `stg_${integrationName}__${resourceName}`;
}

export function integrationModelPath(
  modelDir: string,
  integrationName: string,
  name: string
): string {
  return `${modelDir}/${integrationName}/${name}.yml`;
}

export function integrationSourcePath(
  sourceDir: string,
  integrationName: string,
  resourceName: string
): string {
  return `${sourceDir}/${integrationName}/${rawSourceName(resourceName)}.yml`;
}

export function integrationMetadataPath(
  entityDir: string,
  integrationName: string,
  name: string
): string {
  return `${entityDir}/${integrationName}/${name}.yml`;
}

export function buildSourceTableName(
  rawSchema: string,
  integrationName: string,
  resourceName: string
): string {
  return `${rawSchema}.raw_${integrationName}__${resourceName}`;
}
