import { describe, expect, it } from 'vitest';

import { orderResourcesForExtraction } from '../../src/runtime/resource-order.js';
import type { ResourceSpec } from '../../src/types/index.js';
import { withForEach } from '../helpers/for-each.js';
import { makeResource } from '../helpers/fixtures.js';

describe('orderResourcesForExtraction', () => {
  it('preserves the base order for unrelated resources while moving children behind parents', () => {
    const child = withForEach(
      makeResource({
        name: 'costs',
        input: {
          cost_report_token: { type: 'string', required: true },
        },
      }),
      { resource: 'cost_reports', field: 'token', input: 'cost_report_token' }
    );
    const dashboards = makeResource({ name: 'dashboards' });
    const costReports = makeResource({
      name: 'cost_reports',
      output: { token: { type: 'string', path: '$.token' } },
    });
    const folders = makeResource({ name: 'folders' });

    const ordered = orderResourcesForExtraction([
      { spec: child as ResourceSpec },
      { spec: dashboards as ResourceSpec },
      { spec: costReports as ResourceSpec },
      { spec: folders as ResourceSpec },
    ]);

    expect(ordered.map((resource) => resource.spec.name)).toEqual([
      'dashboards',
      'cost_reports',
      'costs',
      'folders',
    ]);
  });

  it('keeps already-valid explicit orders intact', () => {
    const parent = makeResource({
      name: 'campaigns',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const sibling = makeResource({ name: 'email_accounts' });
    const child = withForEach(
      makeResource({
        name: 'campaign_leads',
        input: {
          campaign_id: { type: 'integer', required: true },
        },
      }),
      { resource: 'campaigns', field: 'id', input: 'campaign_id' }
    );

    const ordered = orderResourcesForExtraction([
      { spec: parent as ResourceSpec },
      { spec: sibling as ResourceSpec },
      { spec: child as ResourceSpec },
    ]);

    expect(ordered.map((resource) => resource.spec.name)).toEqual([
      'campaigns',
      'email_accounts',
      'campaign_leads',
    ]);
  });

  it('warns and preserves declared order when dependencies cannot be resolved', () => {
    const campaigns = withForEach(
      makeResource({
        name: 'campaigns',
        output: { id: { type: 'integer', path: '$.id' } },
      }),
      { resource: 'campaign_leads', field: 'campaign_id', input: 'campaign_id' }
    );
    const campaignLeads = withForEach(
      makeResource({
        name: 'campaign_leads',
        input: {
          campaign_id: { type: 'integer', required: true },
        },
      }),
      { resource: 'campaigns', field: 'id', input: 'campaign_id' }
    );
    const warnings: string[] = [];

    const ordered = orderResourcesForExtraction(
      [{ spec: campaigns as ResourceSpec }, { spec: campaignLeads as ResourceSpec }],
      { onWarning: (message) => warnings.push(message) }
    );

    expect(ordered.map((resource) => resource.spec.name)).toEqual(['campaigns', 'campaign_leads']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('campaigns');
    expect(warnings[0]).toContain('campaign_leads');
  });
});
