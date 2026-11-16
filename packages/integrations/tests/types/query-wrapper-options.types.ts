import {
  FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES,
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  queryResources,
} from '../../src/index.js';
import type {
  GithubIssuesFilter,
  GithubIssuesInput,
  QuerySourceListOptions,
  StripeInvoicesFilter,
  StripeSubscriptionStatus,
  StripeSubscriptionsFilter,
  TwilioListUsageRecordsInput,
} from '../../src/index.js';

type GithubIssuesListOptions = QuerySourceListOptions<
  GithubIssuesInput,
  GithubIssuesFilter,
  typeof FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
>;

const githubIssuesOptions: GithubIssuesListOptions = {
  input: {
    owner: 'bobsled-inc',
    repo: 'bobsled',
  },
  filter: {
    state: 'open',
  },
  limit: 25,
};

void githubIssuesOptions;

queryResources.github.issues.list({
  input: {
    owner: 'bobsled-inc',
    repo: 'bobsled',
  },
  filter: {
    state: 'open',
  },
});

// @ts-expect-error filter-only wrappers do not accept search
queryResources.github.issues.list({ search: 'open' });

queryResources.github.pullRequests.list({
  input: {
    owner: 'bobsled-inc',
    repo: 'bobsled',
  },
  filter: {
    state: 'all',
  },
});

queryResources.stripe.invoices.list({
  filter: {
    status: 'paid',
    customer: { $eq: 'cus_123' },
  },
});

const stripeInvoicesFilter: StripeInvoicesFilter = {
  status: 'open',
};

void stripeInvoicesFilter;

// @ts-expect-error Stripe invoice status is provider-defined
queryResources.stripe.invoices.list({ filter: { status: 'missing' } });

const stripeSubscriptionRecordStatus: StripeSubscriptionStatus = 'active';

void stripeSubscriptionRecordStatus;

// @ts-expect-error `all` is a Stripe subscription filter value, not a record status
const stripeSubscriptionAllRecordStatus: StripeSubscriptionStatus = 'all';

void stripeSubscriptionAllRecordStatus;

const stripeSubscriptionsFilter: StripeSubscriptionsFilter = {
  status: 'all',
};

void stripeSubscriptionsFilter;

queryResources.jira.searchIssues.list({
  input: {
    start_at: 25,
  },
  search: 'project = BOBSLED',
});

// @ts-expect-error search-only wrappers do not accept filters
queryResources.jira.searchIssues.list({ filter: { status: 'Done' } });

const requiredInputSource = makeQuerySource<
  { id: string },
  TwilioListUsageRecordsInput,
  { active?: boolean }
>('twilio', 'list_usage_records', FILTER_ONLY_QUERY_SOURCE_CAPABILITIES);

requiredInputSource.list({
  input: {
    account_sid: 'AC123',
  },
});

// @ts-expect-error wrappers with required context input require an options object
requiredInputSource.list();

// @ts-expect-error wrappers with required context input require input.account_sid
requiredInputSource.list({ filter: { active: true } });

queryResources.twilio.listUsageRecords.list({
  input: {
    account_sid: 'AC123',
  },
  filter: {
    category: 'sms',
    start_date: { gte: '2026-04-01' },
  },
});

// @ts-expect-error Twilio usage records require an account SID context input
queryResources.twilio.listUsageRecords.list({ filter: { category: 'sms' } });

// @ts-expect-error Twilio usage records are filter-only wrappers
queryResources.twilio.listUsageRecords.list({ input: { account_sid: 'AC123' }, search: 'sms' });

const dualCapabilitySource = makeQuerySource<
  { id: string },
  { cursor?: string },
  { active?: boolean }
>('example', 'searchable_records', FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES);

dualCapabilitySource.list({
  filter: {
    active: true,
  },
});

dualCapabilitySource.list({
  search: 'status:active',
});

dualCapabilitySource.list({
  input: {
    cursor: 'next-page',
  },
});

// @ts-expect-error dual-capability wrappers must not accept filter and search together
dualCapabilitySource.list({ filter: { active: true }, search: 'status:active' });

const dualCapabilityRequiredInputSource = makeQuerySource<
  { id: string },
  { tenant_id: string; cursor?: string },
  { active?: boolean }
>('example', 'dual_required', FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES);

dualCapabilityRequiredInputSource.list({
  input: {
    tenant_id: 'tenant_123',
  },
  filter: {
    active: true,
  },
});

dualCapabilityRequiredInputSource.list({
  input: {
    tenant_id: 'tenant_123',
  },
  search: 'status:active',
});

// @ts-expect-error dual-capability wrappers with required input still require that input
dualCapabilityRequiredInputSource.list({ filter: { active: true } });

const searchOnlyRequiredInputSource = makeQuerySource<
  { id: string },
  { account_id: string; region?: string }
>('example', 'searchable_with_required_input', SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES);

searchOnlyRequiredInputSource.list({
  input: {
    account_id: 'acct_123',
  },
});

// @ts-expect-error search-only wrappers with required input still require that input
searchOnlyRequiredInputSource.list({ search: 'active' });
