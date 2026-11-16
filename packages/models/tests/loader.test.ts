import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearModelPackageCache,
  getModelPackage,
  installModelPackage,
  listModelPackages,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  clearModelPackageCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('@bobsled-inc/models', () => {
  it('lists the requested model packages', () => {
    const packages = listModelPackages();
    expect(packages.map((entry) => entry.name)).toEqual([
      'asana',
      'chargebee',
      'freshdesk',
      'github',
      'gong',
      'hubspot',
      'intercom',
      'jira',
      'klaviyo',
      'langsmith',
      'linear',
      'notion',
      'pipedrive',
      'pylon',
      'quickbooks',
      'salesforce',
      'shopify',
      'slack',
      'smartlead',
      'stripe',
      'vantage',
      'vercel',
      'zendesk',
    ]);
  });

  it('does not assign a default company owner to starter models', () => {
    for (const entry of listModelPackages()) {
      const bundle = getModelPackage(entry.name);
      for (const spec of [...bundle.stagingSpecs, ...bundle.martSpecs]) {
        expect(spec.owner).not.toBe('bobsled');
      }
    }
  });

  it('generates source, staging, mart, metric, and relationship files for a package', () => {
    const modelPackage = getModelPackage('stripe');

    expect(modelPackage.sourceSpecs.length).toBeGreaterThan(0);
    expect(modelPackage.stagingSpecs.length).toBe(modelPackage.sourceSpecs.length);
    expect(modelPackage.martSpecs.length).toBeGreaterThan(0);
    expect(modelPackage.metricSpecs.map((spec) => spec.name)).toEqual(
      expect.arrayContaining(['stripe_total_charge_amount', 'stripe_paid_charge_count'])
    );
    expect(modelPackage.relationshipSpecs.map((spec) => spec.name)).toEqual(
      expect.arrayContaining(['stripe_charges_to_customers', 'stripe_refunds_to_charges'])
    );
    expect(modelPackage.files.some((file) => file.path.endsWith('stripe__charges.yml'))).toBe(true);
    expect(
      modelPackage.files.some(
        (file) =>
          file.kind === 'metric' && file.path === 'metrics/stripe/stripe_total_charge_amount.yml'
      )
    ).toBe(true);
    expect(
      modelPackage.files.some(
        (file) =>
          file.kind === 'relationship' &&
          file.path === 'relationships/stripe/stripe_charges_to_customers.yml'
      )
    ).toBe(true);
  });

  it('bundles curated metrics and relationships for every package', () => {
    for (const { name } of listModelPackages()) {
      const modelPackage = getModelPackage(name);
      expect(modelPackage.metricSpecs.length, `${name} metrics`).toBeGreaterThan(0);
      expect(modelPackage.relationshipSpecs.length, `${name} relationships`).toBeGreaterThan(0);
    }
  });

  it.each(listModelPackages().map(({ name }) => name))(
    'keeps %s metric and relationship columns aligned with bundled models',
    (packageName) => {
      const modelPackage = getModelPackage(packageName);
      const models = new Map(
        [...modelPackage.stagingSpecs, ...modelPackage.martSpecs].map((model) => [
          model.name,
          new Set(model.columns.map((column) => column.name)),
        ])
      );

      for (const relationship of modelPackage.relationshipSpecs) {
        const leftColumns = models.get(relationship.left_model);
        const rightColumns = models.get(relationship.right_model);
        expect(leftColumns, `${relationship.name} left model`).toBeDefined();
        expect(rightColumns, `${relationship.name} right model`).toBeDefined();
        for (const columns of relationship.join_columns) {
          expect(leftColumns, `${relationship.name}.${columns.left}`).toContain(columns.left);
          expect(rightColumns, `${relationship.name}.${columns.right}`).toContain(columns.right);
        }

        const modelSpecs = new Map(
          [...modelPackage.stagingSpecs, ...modelPackage.martSpecs].map((model) => [
            model.name,
            model,
          ])
        );
        const leftGrain = modelSpecs.get(relationship.left_model)?.grain;
        const rightGrain = modelSpecs.get(relationship.right_model)?.grain;
        const leftJoinColumns = relationship.join_columns.map((columns) => columns.left);
        const rightJoinColumns = relationship.join_columns.map((columns) => columns.right);
        const grainColumns = (grain: string | string[] | undefined) =>
          grain === undefined ? [] : Array.isArray(grain) ? grain : [grain];

        if (['one_to_one', 'one_to_many'].includes(relationship.relationship_type)) {
          expect(leftJoinColumns, `${relationship.name} left cardinality`).toEqual(
            expect.arrayContaining(grainColumns(leftGrain))
          );
        }
        if (['one_to_one', 'many_to_one'].includes(relationship.relationship_type)) {
          expect(rightJoinColumns, `${relationship.name} right cardinality`).toEqual(
            expect.arrayContaining(grainColumns(rightGrain))
          );
        }
      }

      for (const metric of modelPackage.metricSpecs) {
        const declaredModels = new Set(
          metric.model === undefined ? (metric.models ?? []) : [metric.model]
        );
        for (const match of metric.expression.matchAll(/\{([A-Za-z_]\w*)\}\.([A-Za-z_]\w*)/g)) {
          const [, modelName, columnName] = match;
          expect(declaredModels, `${metric.name}.${modelName}`).toContain(modelName);
          expect(models.get(modelName!), `${metric.name}.${columnName}`).toContain(columnName);
        }
      }
    }
  );

  it.each(listModelPackages().map(({ name }) => name))(
    'keeps %s mart expressions aligned with bundled source columns',
    (packageName) => {
      const modelPackage = getModelPackage(packageName);
      const models = new Map(
        [...modelPackage.stagingSpecs, ...modelPackage.martSpecs].map((model) => [
          model.name,
          new Set(model.columns.map((column) => column.name)),
        ])
      );
      const invalidReferences: string[] = [];

      for (const mart of modelPackage.martSpecs) {
        const availableByRef = new Map<string, Set<string>>();
        const sourceColumns = models.get(mart.source.ref);
        if (sourceColumns) availableByRef.set(mart.source.ref, sourceColumns);

        for (const join of mart.joins ?? []) {
          const joinedColumns = models.get(join.ref);
          if (!joinedColumns) continue;

          if (join.pre_aggregate) {
            availableByRef.set(
              join.ref,
              new Set([
                ...join.pre_aggregate.group_by,
                ...join.pre_aggregate.columns.map((column) => column.name),
              ])
            );
            for (const column of join.pre_aggregate.columns) {
              for (const match of column.expr.matchAll(/\b[A-Za-z_]\w*\.([A-Za-z_]\w*)/g)) {
                if (!joinedColumns.has(match[1]!)) {
                  invalidReferences.push(`${mart.name}:${join.ref}.${match[1]}`);
                }
              }
            }
          } else {
            availableByRef.set(join.ref, joinedColumns);
          }
        }

        const expressions = [
          ...mart.columns.map((column) => column.expr),
          ...(mart.joins ?? []).map((join) => join.on),
        ];
        for (const expression of expressions) {
          for (const match of expression.matchAll(
            /\b((?:stg_)?[a-z0-9_]+__[a-z0-9_]+)\.([A-Za-z_]\w*)/gi
          )) {
            const [, ref, column] = match;
            if (!availableByRef.get(ref!)?.has(column!)) {
              invalidReferences.push(`${mart.name}:${ref}.${column}`);
            }
          }
        }
      }

      expect(invalidReferences).toEqual([]);
    }
  );

  it('preserves multi-entity grains and scoped metric formulas', () => {
    const asana = getModelPackage('asana');
    const quickbooks = getModelPackage('quickbooks');
    const smartlead = getModelPackage('smartlead');

    expect(asana.martSpecs.find((model) => model.name === 'asana__task_projects')?.grain).toEqual([
      'task_id',
      'project_id',
    ]);
    expect(
      quickbooks.martSpecs.find((model) => model.name === 'quickbooks__payment_applications')?.grain
    ).toEqual(['payment_id', 'invoice_id']);
    expect(
      smartlead.martSpecs.find((model) => model.name === 'smartlead__campaign_statistics')?.grain
    ).toEqual(['campaign_id', 'lead_email', 'sequence_number']);

    expect(
      getModelPackage('chargebee').metricSpecs.find(
        (metric) => metric.name === 'chargebee_total_mrr'
      )?.expression
    ).toContain("IN ('active', 'non_renewing')");
    expect(
      getModelPackage('langsmith').metricSpecs.find(
        (metric) => metric.name === 'langsmith_trace_token_count'
      )?.expression
    ).toContain('parent_run_id IS NULL');
    expect(
      getModelPackage('slack').metricSpecs.find(
        (metric) => metric.name === 'slack_top_level_message_count'
      )?.description
    ).toContain('Thread replies are excluded');
    expect(
      getModelPackage('vantage').metricSpecs.find(
        (metric) => metric.name === 'vantage_cost_report_total_cost'
      )?.description
    ).toContain('overlapping reports');
  });

  it('preserves Linear business identifiers expected by the standard marts', () => {
    const modelPackage = getModelPackage('linear');
    const issues = modelPackage.stagingSpecs.find((spec) => spec.name === 'stg_linear__issues');
    const comments = modelPackage.stagingSpecs.find((spec) => spec.name === 'stg_linear__comments');
    const cycles = modelPackage.stagingSpecs.find((spec) => spec.name === 'stg_linear__cycles');

    expect(issues?.columns.map((column) => column.name)).toContain('identifier');
    expect(issues?.columns.map((column) => column.name)).toContain('team_key');
    expect(comments?.columns.map((column) => column.name)).toContain('issue_identifier');
    expect(cycles?.columns.map((column) => column.name)).toContain('team_key');
  });

  it('ships LangSmith conversation mining marts and run payload columns', () => {
    const modelPackage = getModelPackage('langsmith');
    const martNames = modelPackage.martSpecs.map((spec) => spec.name);
    const runs = modelPackage.martSpecs.find((spec) => spec.name === 'langsmith__runs');

    expect(martNames).toContain('langsmith__threads');
    expect(martNames).toContain('langsmith__turns');
    expect(runs?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'thread_id',
        'inputs',
        'input_message',
        'outputs',
        'output_message',
        'messages',
      ])
    );
  });

  it('keeps Vercel deployment timestamps distinct after staging normalization', () => {
    const modelPackage = getModelPackage('vercel');
    const deployments = modelPackage.stagingSpecs.find(
      (spec) => spec.name === 'stg_vercel__deployments'
    );
    const columns = deployments?.columns.map((column) => column.name) ?? [];

    expect(columns).toContain('created_at');
    expect(columns).toContain('created_timestamp');
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('ships complete Vercel resource coverage and semantic context marts', () => {
    const modelPackage = getModelPackage('vercel');
    const martNames = modelPackage.martSpecs.map((spec) => spec.name);
    const expectedResources = [
      'billing_charges',
      'contract_commitments',
      'deployment_details',
      'deployments',
      'metric_catalog',
      'metric_query',
      'metric_schema',
      'projects',
      'sandbox_session_details',
      'sandbox_sessions',
      'sandboxes',
    ];
    const expectedMarts = [
      'vercel__billing_charges',
      'vercel__contract_commitments',
      'vercel__daily_costs',
      'vercel__daily_overview',
      'vercel__deployment_details',
      'vercel__deployments',
      'vercel__metric_catalog',
      'vercel__metric_query_results',
      'vercel__metric_schema',
      'vercel__projects',
      'vercel__sandbox_session_details',
      'vercel__sandbox_sessions',
      'vercel__sandboxes',
    ];

    expect(modelPackage.resourceNames).toEqual(expectedResources);
    expect(modelPackage.sourceSpecs).toHaveLength(expectedResources.length);
    expect(modelPackage.stagingSpecs.map((spec) => spec.name)).toEqual(
      expectedResources.map((name) => `stg_vercel__${name}`)
    );
    expect(martNames).toEqual(expectedMarts);

    const deployments = modelPackage.martSpecs.find((spec) => spec.name === 'vercel__deployments');
    const sessions = modelPackage.martSpecs.find(
      (spec) => spec.name === 'vercel__sandbox_sessions'
    );
    const dailyCosts = modelPackage.martSpecs.find((spec) => spec.name === 'vercel__daily_costs');
    const deploymentDetails = modelPackage.martSpecs.find(
      (spec) => spec.name === 'vercel__deployment_details'
    );
    const metricQueries = modelPackage.martSpecs.find(
      (spec) => spec.name === 'vercel__metric_query_results'
    );

    expect(deployments?.joins?.map((join) => join.ref)).toContain('stg_vercel__projects');
    expect(sessions?.joins?.map((join) => join.ref)).toEqual(
      expect.arrayContaining(['stg_vercel__projects', 'stg_vercel__sandboxes'])
    );
    expect(
      dailyCosts?.columns.filter((column) => column.primary_key).map((column) => column.name)
    ).toEqual(
      expect.arrayContaining([
        'snapshot_id',
        'date',
        'team_id',
        'project_id',
        'service_name',
        'region_id',
        'billing_currency',
        'pricing_currency',
        'charge_category',
        'consumed_unit',
        'pricing_unit',
      ])
    );
    expect(deploymentDetails?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['deployment_detail_id', 'deployment_id', 'resource_config'])
    );
    expect(metricQueries?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'limit',
        'order_by',
        'order_direction',
        'granularity',
        'bucket_timezone',
      ])
    );

    const sandboxes = modelPackage.stagingSpecs.find(
      (spec) => spec.name === 'stg_vercel__sandboxes'
    );
    expect(sandboxes?.columns.find((column) => column.name === 'memory')?.unit).toBe('megabytes');
    expect(
      sandboxes?.columns.find((column) => column.name === 'total_active_cpu_duration_ms')?.unit
    ).toBe('milliseconds');
    const sandboxSessions = modelPackage.stagingSpecs.find(
      (spec) => spec.name === 'stg_vercel__sandbox_sessions'
    );
    expect(sandboxSessions?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['team_id', 'team_slug', 'cwd', 'snapshotted_at'])
    );
    const sandboxSessionDetails = modelPackage.martSpecs.find(
      (spec) => spec.name === 'vercel__sandbox_session_details'
    );
    expect(sandboxSessionDetails?.joins?.map((join) => join.ref)).toEqual(
      expect.arrayContaining(['stg_vercel__projects', 'stg_vercel__sandboxes'])
    );
    expect(sandboxSessionDetails?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'runtime',
        'timeout',
        'cwd',
        'requested_stop_at',
        'snapshotted_at',
        'sandbox_tags',
      ])
    );
    const sandboxSource = modelPackage.sourceSpecs.find((spec) => spec.name === 'raw_sandboxes');
    expect(sandboxSource?.schema.columns.find((column) => column.name === 'memory')?.unit).toBe(
      'megabytes'
    );
  });

  it('installs package files into a project directory with a raw schema override', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bobsled-models-'));
    tempDirs.push(cwd);

    const result = installModelPackage('github', {
      cwd,
      rawSchema: 'landing',
    });

    expect(result.sourceCount).toBeGreaterThan(0);
    expect(result.martCount).toBeGreaterThan(0);
    expect(result.metricCount).toBeGreaterThan(0);
    expect(result.relationshipCount).toBeGreaterThan(0);

    const sourceContent = readFileSync(join(cwd, 'sources', 'github', 'raw_repos.yml'), 'utf-8');
    expect(sourceContent).toContain('table: landing.raw_github__repos');
    expect(
      readFileSync(join(cwd, 'metrics', 'github', 'github_pull_request_count.yml'), 'utf-8')
    ).toContain('type: metric');
    expect(
      readFileSync(
        join(cwd, 'relationships', 'github', 'github_deployments_to_commits.yml'),
        'utf-8'
      )
    ).toContain('type: relationship');
  });

  it('uses default transport variants as canonical model entities', () => {
    const modelPackage = getModelPackage('linear');
    const stagingNames = modelPackage.stagingSpecs.map((spec) => spec.name);

    expect(stagingNames).toContain('stg_linear__issues');
    expect(stagingNames).toContain('stg_linear__cycles');
    expect(stagingNames).not.toContain('stg_linear__issues_graphql');
    expect(stagingNames).not.toContain('stg_linear__issues_mcp');

    const issuesSource = modelPackage.sourceSpecs.find((spec) => spec.name === 'raw_issues');
    expect(issuesSource?.table).toBe('raw.raw_linear__issues_graphql');
  });
});
