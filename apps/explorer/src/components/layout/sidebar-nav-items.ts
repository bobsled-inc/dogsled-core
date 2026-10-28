export interface NavSubItem {
  href: string;
  label: string;
  exact?: boolean;
  activePrefixes?: readonly string[];
}

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  group: string | null;
  groupTitle?: string;
  exact?: boolean;
  activePrefixes?: readonly string[];
  children?: readonly NavSubItem[];
}

export const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: 'grid', group: null },
  {
    href: '/integrations',
    label: 'Integrations',
    icon: 'plug',
    group: 'EXPLORE',
    groupTitle: 'Browse integrations, models, and reference docs',
  },
  { href: '/models', label: 'Models', icon: 'layers', group: 'EXPLORE' },
  { href: '/modeling', label: 'Modeling', icon: 'code-2', group: 'EXPLORE' },
  { href: '/learn', label: 'Learn', icon: 'book-open', group: 'EXPLORE' },
  { href: '/journeys', label: 'Guides', icon: 'compass', group: 'EXPLORE' },
  {
    href: '/pipelines/new',
    label: 'Pipelines',
    icon: 'workflow',
    group: 'OPERATE',
    groupTitle: 'Build pipelines and query data',
    activePrefixes: ['/pipelines/new'],
  },
  { href: '/operate/connections', label: 'Connections', icon: 'key-round', group: 'OPERATE' },
  { href: '/operate/data', label: 'Data', icon: 'table', group: 'OPERATE' },
  { href: '/terminal', label: 'Terminal', icon: 'terminal', group: 'OPERATE' },
  { href: '/agent', label: 'Agent', icon: 'message-circle', group: 'OPERATE' },
  {
    href: '/entity-graph',
    label: 'Overview',
    icon: 'users',
    group: 'ENTITY GRAPH',
    exact: true,
    groupTitle: 'Entity resolution and master data management',
  },
  { href: '/entity-graph/design', label: 'Design', icon: 'sliders', group: 'ENTITY GRAPH' },
  { href: '/entity-graph/resolve', label: 'Resolve', icon: 'git-merge', group: 'ENTITY GRAPH' },
  { href: '/entity-graph/data', label: 'Data', icon: 'database', group: 'ENTITY GRAPH' },
  {
    href: '/demo/shop',
    label: 'Shop',
    icon: 'rocket',
    group: 'DEMO',
    activePrefixes: ['/demo/shop'],
    children: [
      { href: '/demo/shop', label: 'Overview', exact: true },
      { href: '/demo/shop/data', label: 'Data' },
      { href: '/demo/shop/models', label: 'Models' },
      { href: '/demo/shop/lineage', label: 'Lineage' },
      { href: '/demo/shop/metrics', label: 'Metrics' },
      { href: '/demo/shop/queries', label: 'Verified Queries' },
      { href: '/demo/shop/relationships', label: 'Relationships' },
    ],
  },
  {
    href: '/demo/entity-resolution-sdk',
    label: 'Entity Graph + Typed SDK',
    icon: 'rocket',
    group: 'DEMO',
    activePrefixes: ['/demo/entity-resolution-sdk'],
  },
  { href: '/docs', label: 'Docs', icon: 'book-open', group: 'separator' },
] as const satisfies readonly NavItem[];

export type NavItemIcon = (typeof NAV_ITEMS)[number]['icon'];
export type NavItemGroup = (typeof NAV_ITEMS)[number]['group'];
