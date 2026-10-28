import {
  buildEntityGraphHref,
  getEntityGraphScenarioDefinition,
  getEntityGraphOverviewHref,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from './entity-graph-scenarios';

export const ENTITY_GRAPH_SUBNAV = [
  { href: '/entity-graph', label: 'Overview' },
  { href: '/entity-graph/design', label: 'Design' },
  { href: '/entity-graph/resolve', label: 'Resolve' },
  { href: '/entity-graph/data', label: 'Data' },
] as const;

export type EntityGraphSubnavItem = (typeof ENTITY_GRAPH_SUBNAV)[number];

export function isEntityGraphRoute(pathname: string): boolean {
  return pathname === '/entity-graph' || pathname.startsWith('/entity-graph/');
}

export function isEntityGraphSubnavActive(pathname: string, href: string): boolean {
  return href === '/entity-graph'
    ? pathname === '/entity-graph'
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function getEntityGraphSubnavState(
  pathname: string,
  scenarioId: EntityGraphScenarioId = 'default',
  entityId: EntityGraphEntityId = 'company'
) {
  const visible = isEntityGraphRoute(pathname);
  const resolvedScenarioId = scenarioId;
  const scenario = getEntityGraphScenarioDefinition(resolvedScenarioId);
  const resolvedEntityId = scenario.supportedEntities.includes(entityId)
    ? entityId
    : scenario.defaultEntity;
  const items = ENTITY_GRAPH_SUBNAV.map((item) => {
    switch (item.href) {
      case '/entity-graph':
        return {
          basePath: '/entity-graph',
          href: getEntityGraphOverviewHref(resolvedScenarioId, resolvedEntityId),
          label: item.label,
        };
      case '/entity-graph/design':
        return {
          basePath: item.href,
          href: buildEntityGraphHref('/entity-graph/design', {
            scenario: resolvedScenarioId,
            entity: resolvedEntityId,
          }),
          label: item.label,
        };
      case '/entity-graph/resolve':
        return {
          basePath: item.href,
          href: buildEntityGraphHref('/entity-graph/resolve', {
            scenario: resolvedScenarioId,
            entity: resolvedEntityId,
          }),
          label: item.label,
        };
      case '/entity-graph/data':
        return {
          basePath: item.href,
          href: buildEntityGraphHref('/entity-graph/data', {
            scenario: resolvedScenarioId,
            entity: resolvedEntityId,
          }),
          label: item.label,
        };
      default: {
        const exhaustive: never = item;
        throw new Error(`Unhandled Entity Graph subnav item: ${JSON.stringify(exhaustive)}`);
      }
    }
  });

  return {
    visible,
    items: items.map((item) => ({
      ...item,
      active: isEntityGraphSubnavActive(pathname, item.basePath),
    })),
  };
}
