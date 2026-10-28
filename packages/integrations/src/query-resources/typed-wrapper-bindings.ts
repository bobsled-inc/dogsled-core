export interface TypedWrapperBinding {
  integration: string;
  resource: string;
  clientSurface: string;
}

export const typedWrapperBindings: readonly TypedWrapperBinding[] = [
  {
    integration: 'github',
    resource: 'issues',
    clientSurface: 'queryResources.github.issues',
  },
  {
    integration: 'github',
    resource: 'pull_requests',
    clientSurface: 'queryResources.github.pullRequests',
  },
  {
    integration: 'github',
    resource: 'branches',
    clientSurface: 'queryResources.github.branches',
  },
  {
    integration: 'jira',
    resource: 'search_issues',
    clientSurface: 'queryResources.jira.searchIssues',
  },
  {
    integration: 'calendly',
    resource: 'get_event_types',
    clientSurface: 'queryResources.calendly.getEventTypes',
  },
  {
    integration: 'stripe',
    resource: 'products',
    clientSurface: 'queryResources.stripe.products',
  },
  {
    integration: 'stripe',
    resource: 'prices',
    clientSurface: 'queryResources.stripe.prices',
  },
  {
    integration: 'stripe',
    resource: 'customers',
    clientSurface: 'queryResources.stripe.customers',
  },
  {
    integration: 'stripe',
    resource: 'invoices',
    clientSurface: 'queryResources.stripe.invoices',
  },
  {
    integration: 'stripe',
    resource: 'subscriptions',
    clientSurface: 'queryResources.stripe.subscriptions',
  },
  {
    integration: 'twilio',
    resource: 'list_usage_records',
    clientSurface: 'queryResources.twilio.listUsageRecords',
  },
];

const typedWrapperBindingMap = new Map(
  typedWrapperBindings.map(
    (binding) => [`${binding.integration}.${binding.resource}`, binding] as const
  )
);

export function getTypedWrapperBinding(
  integrationName: string,
  resourceName: string
): TypedWrapperBinding | undefined {
  return typedWrapperBindingMap.get(`${integrationName}.${resourceName}`);
}
