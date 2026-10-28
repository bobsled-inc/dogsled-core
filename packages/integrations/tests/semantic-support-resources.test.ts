import { describe, expect, it } from 'vitest';

import { getResourcePath, readYamlFile } from '../src/loader.js';
import { ResourceSpecSchema } from '../src/validate.js';

function resource(integration: string, name: string) {
  return ResourceSpecSchema.parse(readYamlFile(getResourcePath(integration, name)));
}

describe('semantic model support resources', () => {
  it('extracts every Asana task-project membership with a composite key', () => {
    const spec = resource('asana', 'get_task_projects');

    expect(spec.extract.for_each).toMatchObject({
      resource: 'get_tasks',
      field: 'gid',
      input: 'task_gid',
    });
    expect(spec.output['task_gid']?.from).toEqual({ resource: 'get_tasks', path: '$.gid' });
    expect(spec.extract.table?.primary_key).toEqual(['task_gid', 'project_gid']);
  });

  it('extracts every QuickBooks payment-to-invoice application with a composite key', () => {
    const spec = resource('quickbooks', 'payment_applications');

    expect(spec.extract.record_path).toBe('$.Payment.Line');
    expect(spec.extract.for_each).toMatchObject({
      resource: 'payments',
      field: 'id',
      input: 'payment_id',
    });
    expect(spec.extract.table?.primary_key).toEqual(['payment_id', 'invoice_id']);
  });

  it('keeps Smartlead campaign statistics unique across campaigns', () => {
    const spec = resource('smartlead', 'campaign_statistics');

    expect(spec.output['campaign_id']?.from).toEqual({ input: 'campaign_id' });
    expect(spec.extract.table?.primary_key).toEqual([
      'campaign_id',
      'lead_email',
      'sequence_number',
    ]);
  });
});
