import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isHealthCheckCandidate,
  readScopedHealthResource,
  selectHealthCheckResource,
} from '../../src/commands/health-check-resource.js';
import type { ResourceSpec } from '../../src/types/index.js';
import { withForEach } from '../helpers/for-each.js';
import { makeResource } from '../helpers/fixtures.js';

const tempDirs: string[] = [];

function dogsledTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readScopedHealthResource', () => {
  it('reads the first scoped resource from dogsled.yml for the integration', () => {
    const projectRoot = dogsledTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-health-')));
    fs.writeFileSync(
      path.join(projectRoot, 'dogsled.yml'),
      [
        'pipelines:',
        '  vantage:',
        '    schedule: daily',
        '    only:',
        '      - anomaly_alerts',
        '      - costs',
        '',
      ].join('\n')
    );

    expect(readScopedHealthResource(projectRoot, 'vantage')).toBe('anomaly_alerts');
    expect(readScopedHealthResource(projectRoot, 'hubspot')).toBeUndefined();
  });

  it('ignores oversized Dogsled configs', () => {
    const projectRoot = dogsledTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-health-')));
    fs.writeFileSync(path.join(projectRoot, 'dogsled.yml'), 'x'.repeat(1024 * 1024 + 1));

    expect(readScopedHealthResource(projectRoot, 'vantage')).toBeUndefined();
  });
});

describe('health resource selection', () => {
  it('rejects for_each children and required-input resources as default candidates', () => {
    const child = withForEach(
      makeResource({
        name: 'campaign_leads',
        input: {
          campaign_id: { type: 'integer', required: true },
        },
      }),
      { resource: 'campaigns', field: 'id', input: 'campaign_id' }
    );
    const parent = makeResource({ name: 'campaigns' });

    expect(isHealthCheckCandidate(child as ResourceSpec)).toBe(false);
    expect(isHealthCheckCandidate(parent as ResourceSpec)).toBe(true);
  });

  it('prefers the scoped pipeline resource when it is safe to probe', () => {
    const accessGrants = makeResource({ name: 'access_grants' });
    const anomalyAlerts = makeResource({ name: 'anomaly_alerts' });

    const selected = selectHealthCheckResource(
      [accessGrants as ResourceSpec, anomalyAlerts as ResourceSpec],
      'anomaly_alerts'
    );

    expect(selected.name).toBe('anomaly_alerts');
  });

  it('prefers an explicit health-check resource over the scoped pipeline resource', () => {
    const workspaces = makeResource({
      name: 'workspaces',
      health_check: { preferred: true },
    });
    const anomalyAlerts = makeResource({ name: 'anomaly_alerts' });

    const selected = selectHealthCheckResource(
      [anomalyAlerts as ResourceSpec, workspaces as ResourceSpec],
      'anomaly_alerts'
    );

    expect(selected.name).toBe('workspaces');
  });

  it('falls back to the first safe resource when the scoped resource is not probeable', () => {
    const child = withForEach(
      makeResource({
        name: 'campaign_leads',
        input: {
          campaign_id: { type: 'integer', required: true },
        },
      }),
      { resource: 'campaigns', field: 'id', input: 'campaign_id' }
    );
    const parent = makeResource({ name: 'campaigns' });

    const selected = selectHealthCheckResource(
      [child as ResourceSpec, parent as ResourceSpec],
      'campaign_leads'
    );

    expect(selected.name).toBe('campaigns');
  });

  it('rejects resources with non-GET or HEAD methods', () => {
    const postResource = makeResource({
      name: 'create_campaign',
      api: { method: 'POST', endpoint: '/campaigns' },
    });
    const parent = makeResource({ name: 'campaigns' });

    expect(isHealthCheckCandidate(postResource as ResourceSpec)).toBe(false);
    expect(
      selectHealthCheckResource(
        [postResource as ResourceSpec, parent as ResourceSpec],
        'create_campaign'
      ).name
    ).toBe('campaigns');
  });

  it('throws when every resource is unsafe to probe', () => {
    const child = withForEach(
      makeResource({
        name: 'campaign_leads',
        input: {
          campaign_id: { type: 'integer', required: true },
        },
      }),
      { resource: 'campaigns', field: 'id', input: 'campaign_id' }
    );
    const postResource = makeResource({
      name: 'create_campaign',
      api: { method: 'POST', endpoint: '/campaigns' },
    });

    expect(() =>
      selectHealthCheckResource([child as ResourceSpec, postResource as ResourceSpec])
    ).toThrow('No safe resources available for health check');
  });

  it('throws when asked to select from an empty resource list', () => {
    expect(() => selectHealthCheckResource([], 'campaigns')).toThrow(
      'No resources available for health check'
    );
  });
});
