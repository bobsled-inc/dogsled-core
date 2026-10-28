import { getEventTypes as calendlyGetEventTypes } from './calendly-get-event-types.js';
import { branches as githubBranches } from './github-branches.js';
import { issues as githubIssues } from './github-issues.js';
import { pullRequests as githubPullRequests } from './github-pull-requests.js';
import { searchIssues as jiraSearchIssues } from './jira-search-issues.js';
import { customers as stripeCustomers } from './stripe-customers.js';
import { invoices as stripeInvoices } from './stripe-invoices.js';
import { prices as stripePrices } from './stripe-prices.js';
import { products as stripeProducts } from './stripe-products.js';
import { subscriptions as stripeSubscriptions } from './stripe-subscriptions.js';
import { listUsageRecords as twilioListUsageRecords } from './twilio-list-usage-records.js';

export { getEventTypes as calendlyGetEventTypes } from './calendly-get-event-types.js';
export type {
  CalendlyEventType,
  CalendlyGetEventTypesFilter,
  CalendlyGetEventTypesInput,
} from './calendly-get-event-types.js';
export { branches as githubBranches } from './github-branches.js';
export type { GithubBranch, GithubBranchesFilter, GithubBranchesInput } from './github-branches.js';
export { issues as githubIssues } from './github-issues.js';
export { pullRequests as githubPullRequests } from './github-pull-requests.js';
export type {
  GithubPullRequest,
  GithubPullRequestsFilter,
  GithubPullRequestsInput,
  GithubPullRequestState,
} from './github-pull-requests.js';
export { searchIssues as jiraSearchIssues } from './jira-search-issues.js';
export type { GithubIssue, GithubIssuesFilter, GithubIssuesInput } from './github-issues.js';
export type { JiraIssue, JiraSearchIssuesInput } from './jira-search-issues.js';
export type {
  QuerySourceCapabilities,
  QuerySource,
  QuerySourceListOptions,
  MongoContainsFilter,
  MongoEqFilter,
  MongoGteFilter,
  MongoLteFilter,
} from './make-query-source.js';
export {
  makeQuerySource,
  FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES,
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES,
} from './make-query-source.js';
export { customers as stripeCustomers } from './stripe-customers.js';
export type {
  StripeCustomer,
  StripeCustomersFilter,
  StripeCustomersInput,
} from './stripe-customers.js';
export { invoices as stripeInvoices } from './stripe-invoices.js';
export type {
  StripeInvoice,
  StripeInvoicesFilter,
  StripeInvoicesInput,
  StripeInvoiceStatus,
} from './stripe-invoices.js';
export { prices as stripePrices } from './stripe-prices.js';
export type {
  StripePrice,
  StripePricesFilter,
  StripePricesInput,
  StripePriceType,
} from './stripe-prices.js';
export { products as stripeProducts } from './stripe-products.js';
export type {
  StripeProduct,
  StripeProductMetadata,
  StripeProductsFilter,
  StripeProductsInput,
} from './stripe-products.js';
export { subscriptions as stripeSubscriptions } from './stripe-subscriptions.js';
export type {
  StripeSubscription,
  StripeSubscriptionsFilter,
  StripeSubscriptionsInput,
  StripeSubscriptionStatusFilter,
  StripeSubscriptionStatus,
} from './stripe-subscriptions.js';
export { listUsageRecords as twilioListUsageRecords } from './twilio-list-usage-records.js';
export type {
  TwilioListUsageRecordsFilter,
  TwilioListUsageRecordsInput,
  TwilioUsageRecord,
} from './twilio-list-usage-records.js';

export const queryResources = {
  calendly: {
    getEventTypes: calendlyGetEventTypes,
  },
  github: {
    branches: githubBranches,
    issues: githubIssues,
    pullRequests: githubPullRequests,
  },
  jira: {
    searchIssues: jiraSearchIssues,
  },
  stripe: {
    customers: stripeCustomers,
    invoices: stripeInvoices,
    prices: stripePrices,
    products: stripeProducts,
    subscriptions: stripeSubscriptions,
  },
  twilio: {
    listUsageRecords: twilioListUsageRecords,
  },
} as const;
