import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readYamlFile } from '../src/loader.js';
import { getIntegrationsDir } from '../src/index.js';

interface VantageForEachSpec {
  field: string;
  input: string;
  resource: string;
}

interface VantageTableSpec {
  load_strategy?: string;
  primary_key?: string[];
}

interface VantageExtractSpec {
  for_each?: VantageForEachSpec;
  pagination?: unknown;
  table?: VantageTableSpec;
}

interface VantageInputFieldSpec {
  default?: number;
}

interface VantageResourceSpec {
  extract?: VantageExtractSpec;
  health_check?: {
    preferred?: boolean;
  };
  input?: {
    limit?: VantageInputFieldSpec;
  };
}

interface VantageRateLimitSpec {
  burst?: number;
  requests_per_second?: number;
}

interface VantageSourceSpec {
  transports?: Array<{
    rate_limit?: VantageRateLimitSpec;
  }>;
}

function readVantageResource(name: string): VantageResourceSpec {
  return readYamlFile(
    join(getIntegrationsDir(), 'vantage', 'resources', `${name}.yml`)
  ) as VantageResourceSpec;
}

describe('vantage workspace-scoped resources', () => {
  for (const resourceName of ['cost_provider_accounts', 'cost_providers', 'cost_services']) {
    it(`${resourceName} iterates over workspaces`, () => {
      const resource = readVantageResource(resourceName);
      const forEach = resource.extract?.for_each;

      expect(forEach).toBeDefined();
      expect(forEach).toMatchObject({
        resource: 'workspaces',
        field: 'token',
        input: 'workspace_token',
      });
    });

    it(`${resourceName} is a full-refresh snapshot without pagination`, () => {
      const resource = readVantageResource(resourceName);
      expect(resource.extract?.pagination).toBeUndefined();
      expect(resource.extract?.table?.load_strategy).toBe('full_refresh');
      expect(resource.extract?.table?.primary_key).toContain('workspace_token');
    });
  }
});

describe('vantage daily resource defaults', () => {
  const resourceLimitDefaults = {
    anomaly_alerts: 1000,
    audit_logs: 1000,
    budget_alerts: 1000,
    budgets: 1000,
    business_metrics: 1000,
    cost_alerts: 1000,
    cost_reports: 1000,
    costs: 5000,
    dashboards: 1000,
    folders: 1000,
    recommendations: 1000,
    segments: 1000,
    tags: 1000,
    teams: 1000,
    users: 1000,
    workspaces: 1000,
  } as const;

  for (const [resourceName, expectedLimit] of Object.entries(resourceLimitDefaults)) {
    it(`${resourceName} uses the maximum page size by default`, () => {
      const resource = readVantageResource(resourceName);
      const limit = resource.input?.limit;

      expect(limit?.default).toBe(expectedLimit);
    });
  }

  it('uses a conservative transport rate limit', () => {
    const source = readYamlFile(
      join(getIntegrationsDir(), 'vantage', 'source.yml')
    ) as VantageSourceSpec;
    const rateLimit = source.transports?.[0]?.rate_limit;

    expect(rateLimit).toMatchObject({
      requests_per_second: 1,
      burst: 1,
    });
  });

  it('marks workspaces as the preferred health-check resource', () => {
    const resource = readVantageResource('workspaces');

    expect(resource.health_check?.preferred).toBe(true);
  });
});
