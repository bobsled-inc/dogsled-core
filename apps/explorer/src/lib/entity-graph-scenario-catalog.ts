import {
  ENTITY_GRAPH_DEFAULT_RESOLUTION_SPEC,
  ENTITY_GRAPH_DEFAULT_SURVIVORSHIP_SPEC,
} from './entity-graph-constants';
import type {
  EntityGraphEntityDefinition,
  EntityGraphEntityId,
  EntityGraphScenarioDefinition,
  EntityGraphScenarioId,
} from './entity-graph-scenarios';

export const COMPANY_ENTITY: EntityGraphEntityDefinition = {
  id: 'company',
  label: 'Company Master',
  singularLabel: 'company',
  pluralLabel: 'companies',
  description: 'Resolve company identities across Shopify, HubSpot, Zendesk, and CRM.',
  defaultResolutionSpec: ENTITY_GRAPH_DEFAULT_RESOLUTION_SPEC,
  defaultSurvivorshipSpec: ENTITY_GRAPH_DEFAULT_SURVIVORSHIP_SPEC,
  compareFields: [
    { key: 'name', label: 'Name', column: 'name', scoreKey: 'standardized_name' },
    { key: 'website', label: 'Website', column: 'website', scoreKey: 'standardized_website' },
    { key: 'phone', label: 'Phone', column: 'phone', scoreKey: 'standardized_phone' },
    { key: 'country', label: 'Country', column: 'country', scoreKey: 'standardized_country' },
  ],
  memberFields: [
    { key: 'name', label: 'Name', column: 'name' },
    { key: 'website', label: 'Website', column: 'website' },
    { key: 'phone', label: 'Phone', column: 'phone' },
    { key: 'country', label: 'Country', column: 'country' },
    { key: 'source_updated_at', label: 'Updated', column: 'updated_at', format: 'datetime' },
  ],
  goldenRecordLabels: {
    name: 'Name',
    website: 'Website',
    phone: 'Phone',
    country: 'Country',
  },
};

export const CUSTOMER_ENTITY: EntityGraphEntityDefinition = {
  id: 'customer',
  label: 'Customer 360',
  singularLabel: 'customer',
  pluralLabel: 'customers',
  description:
    'Resolve lifecycle customer profiles across CRM, booking, POS, and membership systems.',
  defaultResolutionSpec: 'customer_resolution',
  defaultSurvivorshipSpec: 'customer_survivorship',
  compareFields: [
    {
      key: 'full_name',
      label: 'Full name',
      column: 'full_name',
      scoreKey: 'standardized_full_name',
    },
    { key: 'email', label: 'Email', column: 'email', scoreKey: 'standardized_email' },
    { key: 'phone', label: 'Phone', column: 'phone', scoreKey: 'standardized_phone' },
    {
      key: 'home_store_name',
      label: 'Home store',
      column: 'home_store_name',
      scoreKey: 'standardized_home_store_name',
    },
    {
      key: 'membership_status',
      label: 'Membership',
      column: 'membership_status',
      scoreKey: 'standardized_membership_status',
    },
    {
      key: 'lifetime_value',
      label: 'Lifetime value',
      column: 'lifetime_value',
      scoreKey: 'lifetime_value',
      format: 'currency',
    },
  ],
  memberFields: [
    { key: 'full_name', label: 'Full name', column: 'full_name' },
    { key: 'email', label: 'Email', column: 'email' },
    { key: 'phone', label: 'Phone', column: 'phone' },
    { key: 'home_store_name', label: 'Home store', column: 'home_store_name' },
    { key: 'customer_stage', label: 'Lifecycle', column: 'customer_stage' },
    { key: 'membership_status', label: 'Membership', column: 'membership_status' },
    { key: 'last_visit_at', label: 'Last visit', column: 'last_visit_at', format: 'datetime' },
    {
      key: 'lifetime_value',
      label: 'Lifetime value',
      column: 'lifetime_value',
      format: 'currency',
    },
  ],
  goldenRecordLabels: {
    full_name: 'Full name',
    email: 'Email',
    phone: 'Phone',
    home_store_name: 'Home store',
    customer_stage: 'Lifecycle',
    membership_status: 'Membership',
    last_visit_at: 'Last visit',
    lifetime_value: 'Lifetime value',
  },
};

export const LOCATION_ENTITY: EntityGraphEntityDefinition = {
  id: 'location',
  label: 'Location Master',
  singularLabel: 'location',
  pluralLabel: 'locations',
  description:
    'Resolve store identities across web, ops, marketing, and strategy context into one master.',
  defaultResolutionSpec: 'location_resolution',
  defaultSurvivorshipSpec: 'location_survivorship',
  compareFields: [
    {
      key: 'location_name',
      label: 'Location name',
      column: 'location_name',
      scoreKey: 'standardized_location_name',
    },
    { key: 'website', label: 'Website', column: 'website', scoreKey: 'standardized_website' },
    { key: 'phone', label: 'Phone', column: 'phone', scoreKey: 'standardized_phone' },
    { key: 'city', label: 'City', column: 'city', scoreKey: 'standardized_city' },
    { key: 'state', label: 'State', column: 'state', scoreKey: 'standardized_state' },
    { key: 'region', label: 'Region', column: 'region', scoreKey: 'standardized_region' },
    {
      key: 'ownership_model',
      label: 'Ownership',
      column: 'ownership_model',
      scoreKey: 'standardized_ownership_model',
    },
  ],
  memberFields: [
    { key: 'location_name', label: 'Location name', column: 'location_name' },
    { key: 'website', label: 'Website', column: 'website' },
    { key: 'phone', label: 'Phone', column: 'phone' },
    { key: 'city', label: 'City', column: 'city' },
    { key: 'state', label: 'State', column: 'state' },
    { key: 'region', label: 'Region', column: 'region' },
    { key: 'ownership_model', label: 'Ownership', column: 'ownership_model' },
    {
      key: 'nearest_growth_context',
      label: 'Growth context',
      column: 'nearest_growth_context',
    },
  ],
  goldenRecordLabels: {
    location_name: 'Location name',
    website: 'Website',
    phone: 'Phone',
    city: 'City',
    state: 'State',
    region: 'Region',
    ownership_model: 'Ownership',
    nearest_growth_context: 'Growth context',
  },
};

export const SCENARIO_ENTITIES: Record<EntityGraphEntityId, EntityGraphEntityDefinition> = {
  company: COMPANY_ENTITY,
  customer: CUSTOMER_ENTITY,
  location: LOCATION_ENTITY,
};

export const SCENARIO_DEFINITIONS: Record<EntityGraphScenarioId, EntityGraphScenarioDefinition> = {
  default: {
    id: 'default',
    label: 'Company sandbox',
    shortLabel: 'Default',
    description:
      'The original Explorer Entity Graph sandbox for designing and resolving company identities.',
    workspaceDir: 'workspace/entity-graph-demo',
    schema: 'entity_graph_demo',
    defaultEntity: 'company',
    supportedEntities: ['company'],
    landingKpis: [
      {
        label: 'Starter workspace',
        value: 'Company sandbox',
        context: 'Shopify + HubSpot + Zendesk + CRM',
      },
      {
        label: 'Best for',
        value: 'Product exploration',
        context: 'Design specs, run the pipeline, inspect queue and clusters',
      },
    ],
    heroExamples: [],
  },
};
