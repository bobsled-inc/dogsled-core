import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  renderQueryResourceAuditJson,
  renderQueryResourceAuditMarkdown,
} from '../scripts/audit-query-resources.js';
import { clearCache } from '../src/loader.js';
import { auditQueryResources } from '../src/query-resources/audit.js';

describe('query resource audit', () => {
  let report: ReturnType<typeof auditQueryResources>;
  let markdown: string;

  beforeAll(() => {
    clearCache();
    report = auditQueryResources();
    markdown = renderQueryResourceAuditMarkdown(report);
  }, 30_000);

  it('classifies the complete catalog into deterministic readiness buckets', () => {
    const bucketContents = getBucketContents(report);

    expect(report.summary.queryResources.total).toBe(106);
    expect(report.summary.queryResources.wrapperBacked).toBe(11);
    expect(report.summary.queryResources.discoveryOnly).toBe(93);
    expect(bucketContents.wrapper_backed).toEqual([
      'calendly.get_event_types',
      'github.branches',
      'github.issues',
      'github.pull_requests',
      'jira.search_issues',
      'stripe.customers',
      'stripe.invoices',
      'stripe.prices',
      'stripe.products',
      'stripe.subscriptions',
      'twilio.list_usage_records',
    ]);
    expect(bucketContents.discovery_only).toHaveLength(93);
    expect(bucketContents.discovery_only).toEqual(
      expect.arrayContaining([
        'asana.get_projects',
        'bamboohr.list_time_off_requests',
        'confluence.get_audit_records',
        'notion.pages_rest',
        'servicenow.incidents',
        'sentry.list_your_organizations',
        'stripe.payment_methods',
      ])
    );

    expect(bucketContents.blocked_by_billing).toContain('exa.search');
    expect(bucketContents.not_a_fit_non_http).toEqual(
      expect.arrayContaining(['bigquery.query_results', 'snowflake.query_results'])
    );
    expect(bucketContents.query_ready ?? []).toEqual([]);
    expect(bucketContents.search_ready_needs_semantic_review ?? []).toEqual([]);
    expect(bucketContents.search_ready_semantically_blocked).toEqual([
      'front.list_contacts',
      'front.list_conversations',
    ]);

    const expectedScalarCleanupCases = [
      'clickup.get_tasks',
      'intercom.list_activity_logs',
      'posthog.persons',
      'vantage.tags',
      'zoom.meetings',
    ];
    expect(bucketContents.query_ready_after_scalar_cleanup).toEqual(expectedScalarCleanupCases);
  });

  it('emits stable JSON across repeated audit runs', () => {
    clearCache();
    const first = renderQueryResourceAuditJson(auditQueryResources());
    clearCache();
    const second = renderQueryResourceAuditJson(auditQueryResources());

    expect(second).toBe(first);
  }, 30_000);

  it('has no unreviewed query-ready or search-review candidates after promotion', () => {
    const bucketContents = getBucketContents(report);

    expect(bucketContents.query_ready ?? []).toEqual([]);
    expect(bucketContents.search_ready_needs_semantic_review ?? []).toEqual([]);
  });

  it('reports scalar-cleanup blockers for non-scalar outputs and incompatible scalar types', () => {
    expect(getEntry(report, 'datadog.list_monitors')).toMatchObject({
      bucket: 'discovery_only',
      reasonCodes: ['existing_query_discovery', 'unresolved_scalar_cleanup_blockers'],
    });
    expect(getEntry(report, 'datadog.list_monitors')?.blockers).toContainEqual(
      expect.objectContaining({
        input: 'tags',
        field: 'tags',
        reason: 'output_not_scalar',
      })
    );
    expect(getEntry(report, 'pipedrive.get_activities')?.blockers).toContainEqual(
      expect.objectContaining({
        input: 'done',
        field: 'done',
        reason: 'incompatible_scalar_types',
      })
    );
  });

  it('promotes ServiceNow sysparm_query resources after preserving ORDERBY defaults', () => {
    const entry = getEntry(report, 'servicenow.problems');

    expect(entry).toMatchObject({
      bucket: 'discovery_only',
      reasonCodes: ['existing_query_discovery'],
    });
  });

  it('keeps Front q object resources semantically blocked', () => {
    expect(getEntry(report, 'front.list_contacts')).toMatchObject({
      bucket: 'search_ready_semantically_blocked',
      reasonCodes: ['front_q_query_object_requires_structured_filters'],
      candidateSearch: {
        input: 'q',
        dialect: 'front_q_query_object',
      },
    });
  });

  it('keeps billable resources blocked even when they expose search-like inputs', () => {
    expect(getEntry(report, 'exa.search')).toMatchObject({
      bucket: 'blocked_by_billing',
      reasonCodes: ['billing_metadata_present'],
    });
  });

  it('renders deterministic Markdown and keeps the checked-in report current', () => {
    const reportFile = readFileSync(
      new URL('../QUERY_RESOURCE_AUDIT.md', import.meta.url),
      'utf-8'
    );

    expect(markdown).toContain('## query_ready (0)');
    expect(markdown).toContain('## search_ready_needs_semantic_review (0)');
    expect(markdown).toContain('front_q_query_object');
    expect(markdown).not.toContain('```yaml');
    expect(normalizeEol(reportFile).trim()).toBe(normalizeEol(markdown).trim());
  });
});

type AuditBucket = ReturnType<typeof auditQueryResources>['entries'][number]['bucket'];

function getBucketContents(
  report: ReturnType<typeof auditQueryResources>
): Partial<Record<AuditBucket, string[]>> {
  const bucketContents: Partial<Record<AuditBucket, string[]>> = {};
  for (const entry of report.entries) {
    const bucket = bucketContents[entry.bucket] ?? [];
    bucket.push(`${entry.integration}.${entry.resource}`);
    bucketContents[entry.bucket] = bucket;
  }
  return bucketContents;
}

function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function getEntry(
  report: ReturnType<typeof auditQueryResources>,
  key: string
): ReturnType<typeof auditQueryResources>['entries'][number] | undefined {
  return report.entries.find((entry) => `${entry.integration}.${entry.resource}` === key);
}
