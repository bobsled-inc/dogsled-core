import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, RUN_SUMMARY_VERSION } from '@bobsled-inc/protocol';
import { makeProvider, makeResource } from '../helpers/fixtures.js';
import { FAKE_SERVER_CERT, createFakeHttpsServer, type FakeServer } from './helpers/fake-server.js';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx/esm');
const cliEntry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe('CLI protocol', () => {
  let server: FakeServer | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }

    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a PostHog-shaped pipeline when only events is project-local', async () => {
    server = await createFakeHttpsServer([
      { path: '/organizations', handler: () => ({ body: [{ id: 1 }] }) },
      {
        path: '/organizations/{organizationId}/projects',
        handler: () => ({ body: [{ id: 7 }] }),
      },
      {
        path: '/projects/{projectId}/events',
        handler: () => ({ body: [{ id: 101 }] }),
      },
      { path: '/persons', handler: () => ({ body: [{ id: 201 }] }) },
      { path: '/event_definitions', handler: () => ({ body: [{ id: 301 }] }) },
      { path: '/feature_flags', handler: () => ({ body: [{ id: 401 }] }) },
    ]);

    const projectDir = makeTempDir('extractor-cli-posthog-overrides-');
    const bundledDir = path.join(projectDir, 'bundled');
    const bundledResourceDir = path.join(bundledDir, 'posthog', 'resources');
    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'posthog'), { recursive: true });
    fs.mkdirSync(bundledResourceDir, { recursive: true });

    const integrationSpec = makeProvider(server.url, { name: 'posthog' });
    const organizations = makeResource({
      name: 'organizations',
      integration: 'posthog',
      endpoint: '/organizations',
      output: { id: { type: 'integer', path: '$.id' } },
    });
    const projects = makeResource({
      name: 'projects',
      integration: 'posthog',
      endpoint: '/organizations/${{ input.organization_id }}/projects',
      input: { organization_id: { type: 'integer' } },
      output: {
        id: { type: 'integer', path: '$.id' },
        organization_id: {
          type: 'integer',
          from: { resource: 'organizations', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'organizations', field: 'id', input: 'organization_id' },
        table: { primary_key: ['organization_id', 'id'] },
      },
    });
    const events = makeResource({
      name: 'events',
      integration: 'posthog',
      endpoint: '/projects/${{ input.project_id }}/events',
      input: { project_id: { type: 'integer' } },
      output: {
        id: { type: 'integer', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
        organization_id: {
          type: 'integer',
          from: { resource: 'organizations', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
        table: { primary_key: ['organization_id', 'project_id', 'id'] },
      },
    });

    fs.writeFileSync(
      path.join(projectDir, 'extractor.yml'),
      YAML.stringify({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
        state_dir: '.extractor',
        output_dir: 'output',
        default_output: 'stdout',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'integrations', 'posthog.yml'),
      YAML.stringify(integrationSpec),
      'utf-8'
    );
    fs.writeFileSync(path.join(projectDir, 'fake-ca.pem'), FAKE_SERVER_CERT, 'utf-8');

    // The local file is the only project-authored resource. Its endpoint is
    // intentionally different from the bundled events file below so the run
    // also proves local precedence, not just sibling visibility.
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'posthog', 'events.yml'),
      YAML.stringify(events),
      'utf-8'
    );

    const bundledResources = [
      organizations,
      projects,
      makeResource({
        name: 'events',
        integration: 'posthog',
        endpoint: '/bundled-events',
        output: { id: { type: 'integer', path: '$.id' } },
      }),
      ...['persons', 'event_definitions', 'feature_flags'].map((name) =>
        makeResource({
          name,
          integration: 'posthog',
          endpoint: `/${name}`,
          output: { id: { type: 'integer', path: '$.id' } },
        })
      ),
    ];
    for (const resource of bundledResources) {
      fs.writeFileSync(
        path.join(bundledResourceDir, `${resource.name}.yml`),
        YAML.stringify(resource),
        'utf-8'
      );
    }

    const result = await runCli(
      [
        'run',
        '--integration',
        'posthog',
        'organizations',
        'projects',
        'events',
        'persons',
        'event_definitions',
        'feature_flags',
      ],
      projectDir,
      {
        DOGSLED_BUNDLED_INTEGRATIONS_DIR: bundledDir,
        NODE_EXTRA_CA_CERTS: path.join(projectDir, 'fake-ca.pem'),
      }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const records = parseJsonLines(result.stdout).filter((message) => message['type'] === 'RECORD');
    expect(new Set(records.map((message) => message['stream']))).toEqual(
      new Set([
        'organizations',
        'projects',
        'events',
        'persons',
        'event_definitions',
        'feature_flags',
      ])
    );
    expect(records.find((message) => message['stream'] === 'events')?.['record']).toMatchObject({
      id: 101,
      project_id: 7,
      organization_id: 1,
    });
  });

  it('smoke-runs init then validate with JSON stderr by default', async () => {
    const workspaceDir = makeTempDir('extractor-cli-smoke-');
    const projectDir = path.join(workspaceDir, 'demo');

    const initResult = await runCli(['init', projectDir], process.cwd());
    expect(initResult.exitCode).toBe(0);
    expect(initResult.stdout).toBe('');
    expect(parseJsonLines(initResult.stderr).every((message) => message.type === 'LOG')).toBe(true);

    const validateResult = await runCli(['validate'], projectDir);
    expect(validateResult.exitCode).toBe(0);
    expect(validateResult.stdout).toBe('');
    expect(parseJsonLines(validateResult.stderr)).toContainEqual(
      expect.objectContaining({
        type: 'LOG',
        level: 'info',
        message: expect.stringContaining('Validated'),
      })
    );
  });

  it('validates nested source resources by canonical spec name', async () => {
    const projectDir = makeTempDir('extractor-cli-source-target-');
    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'linear', 'issues'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'extractor.yml'),
      YAML.stringify({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'integrations', 'linear.yml'),
      YAML.stringify({
        spec_version: '2',
        type: 'source',
        name: 'linear',
        transports: [
          {
            id: 'mcp',
            type: 'mcp_http',
            url: 'https://mcp.linear.app/mcp',
            auth: { type: 'none' },
          },
        ],
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'linear', 'issues', 'mcp.yml'),
      YAML.stringify({
        type: 'resource',
        name: 'issues_mcp',
        via: 'mcp',
        description: 'Linear issues from MCP',
        tool: { tool_name: 'list_issues' },
        input: {},
        output: {
          id: { type: 'string', path: '$.id' },
        },
        extract: {
          record_path: '$.issues',
          table: { primary_key: ['id'] },
        },
      }),
      'utf-8'
    );

    const result = await runCli(['validate', 'linear/issues_mcp', '--format', 'json'], projectDir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: 0 });
  });

  it('rejects a lookup-only Resource before an extraction run', async () => {
    const project = makeProject('https://api.example.com');
    fs.writeFileSync(
      path.join(project.projectDir, 'resources', 'test_api', 'test_items.yml'),
      YAML.stringify({
        type: 'resource',
        name: 'test_items',
        description: 'Find one item',
        output: { id: { type: 'string', path: '$.id' } },
        lookup: {
          description: 'Find one item',
          api: { endpoint: '/items/${{ input.id }}', method: 'GET' },
          input: { id: { type: 'string', required: true } },
        },
      }),
      'utf-8'
    );

    const result = await runCli(
      ['run', '--integration', 'test_api', 'test_items'],
      project.projectDir
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('only supports lookup');
    expect(result.stderr).toContain('dogsled extract lookup');
  });

  it('includes non-semantic warnings in validate JSON output', async () => {
    const project = makeProject('https://api.example.com');
    const resourcePath = path.join(project.projectDir, 'resources', 'test_api', 'test_items.yml');
    const resource = YAML.parse(fs.readFileSync(resourcePath, 'utf-8')) as Record<string, unknown>;
    resource['api'] = { endpoint: '/items/${{ input.item_id }}', method: 'GET' };
    resource['input'] = { item_id: { type: 'string', required: true } };
    fs.writeFileSync(resourcePath, YAML.stringify(resource), 'utf-8');

    const result = await runCli(['validate', '--format', 'json'], project.projectDir);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      errors: number;
      warnings: number;
      details?: unknown;
      warning_details: Array<{ spec: string; warning: string }>;
    };
    expect(payload.errors).toBe(0);
    expect(payload.warnings).toBe(1);
    expect(payload.details).toBeUndefined();
    expect(payload.warning_details).toContainEqual({
      spec: 'test_api/test_items',
      warning: "path parameter 'item_id' requires a value — add for_each or provide via --input",
    });
  });

  it('supports semantic-check warning and strict validation modes', async () => {
    const project = makeProject('https://api.example.com');

    const warnResult = await runCli(
      ['validate', '--semantic-check', '--format', 'json'],
      project.projectDir
    );
    expect(warnResult.exitCode).toBe(0);
    expect(JSON.parse(warnResult.stdout)).toMatchObject({
      errors: 0,
      warnings: expect.any(Number),
    });
    expect(parseJsonLines(warnResult.stderr)).toContainEqual(
      expect.objectContaining({
        type: 'LOG',
        level: 'warn',
        message: expect.stringContaining('missing semantic_role'),
      })
    );

    const strictResult = await runCli(
      ['validate', '--semantic-check=strict', '--format', 'json'],
      project.projectDir
    );
    expect(strictResult.exitCode).toBe(2);
    expect(JSON.parse(strictResult.stdout)).toMatchObject({
      errors: expect.any(Number),
      details: expect.arrayContaining([
        expect.objectContaining({
          error: expect.stringContaining('missing semantic_role'),
        }),
      ]),
    });
  });

  it('keeps stdout protocol-only and stderr JSON-only in default mode', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/items',
        handler: () => ({ body: [{ id: 1, name: 'alpha' }] }),
      },
    ]);

    const project = makeProject(server.url);
    const result = await runCli(
      ['run', '--integration', 'test_api', 'test_items'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    const stdoutMessages = parseJsonLines(result.stdout);
    const stderrMessages = parseJsonLines(result.stderr);

    expect(stdoutMessages.map((message) => message.type)).toEqual(['SCHEMA', 'RECORD', 'STATE']);
    expect(
      stderrMessages.every((message) => message.type === 'LOG' || message.type === 'METRIC')
    ).toBe(true);
    expect(stdoutMessages.every((message) => message._v === PROTOCOL_VERSION)).toBe(true);
    expect(stderrMessages.every((message) => message._v === PROTOCOL_VERSION)).toBe(true);
    expect(result.stderr).not.toContain('[info]');
  });

  it('writes a versioned run_summary.json when output-dir is provided', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/items',
        handler: () => ({ body: [{ id: 1, name: 'alpha' }] }),
      },
    ]);

    const project = makeProject(server.url);
    const summaryDir = path.join(project.projectDir, 'summary');
    fs.mkdirSync(summaryDir, { recursive: true });

    const result = await runCli(
      ['run', '--integration', 'test_api', 'test_items', '--output-dir', summaryDir],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);

    const runSummary = JSON.parse(
      fs.readFileSync(path.join(summaryDir, 'run_summary.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(runSummary).toMatchObject({
      _v: RUN_SUMMARY_VERSION,
      type: 'RUN_SUMMARY',
      integration: 'test_api',
      status: 'success',
      totals: {
        resources_total: 1,
        resources_succeeded: 1,
        records_emitted: 1,
      },
      resources: {
        test_items: expect.objectContaining({
          status: 'success',
          records_emitted: 1,
        }),
      },
    });
  });

  it('fails the run when a for_each child is extracted without its parent', async () => {
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [{ token: 'w1' }] }) },
      { path: '/children/{token}', handler: () => ({ body: [{ id: 1 }] }) },
    ]);

    const project = makeForEachProject(server.url);
    const summaryDir = path.join(project.projectDir, 'summary');
    fs.mkdirSync(summaryDir, { recursive: true });

    // Select only the child. It cannot see the absent parent's in-memory
    // forEachCache, so the run must fail loudly rather than silently extract
    // zero rows.
    const result = await runCli(
      ['run', '--integration', 'test_api', 'children', '--output-dir', summaryDir],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(1);
    const runSummary = JSON.parse(
      fs.readFileSync(path.join(summaryDir, 'run_summary.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(runSummary).toMatchObject({
      status: 'failure',
      totals: { resources_failed: 1 },
      resources: {
        children: expect.objectContaining({
          status: 'error',
          failure_reason: 'for_each_parent_not_co_scheduled',
          error: expect.stringContaining('did not run in this extraction process'),
        }),
      },
    });
  });

  it('extracts a for_each child directly when all bound inputs are explicit', async () => {
    const requestedPaths: string[] = [];
    server = await createFakeHttpsServer([
      {
        path: '/children/{token}',
        handler: (_req, url) => {
          requestedPaths.push(url.pathname);
          return { body: [{ id: 1 }] };
        },
      },
    ]);

    const project = makeForEachProject(server.url);
    const result = await runCli(
      ['run', '--integration', 'test_api', 'children', '--input', 'parent_token=target'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    expect(requestedPaths).toEqual(['/children/target']);
  });

  it('does not overwrite or widen explicit child inputs when the parent is also selected', async () => {
    const requestedPaths: string[] = [];
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [{ token: 'w1' }, { token: 'w2' }] }) },
      {
        path: '/children/{token}',
        handler: (_req, url) => {
          requestedPaths.push(url.pathname);
          return { body: [{ id: 1 }] };
        },
      },
    ]);

    const project = makeForEachProject(server.url);
    const result = await runCli(
      [
        'run',
        '--integration',
        'test_api',
        'parents',
        'children',
        '--resource-inputs-json',
        JSON.stringify({ children: { parent_token: 'target' } }),
      ],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    expect(requestedPaths).toEqual(['/children/target']);
  });

  it('replaces a partial explicit multi-binding tuple entirely from each parent', async () => {
    const requestedPaths: string[] = [];
    server = await createFakeHttpsServer([
      {
        path: '/parents',
        handler: () => ({
          body: [
            { workspace_id: 'w1', block_id: 'b1' },
            { workspace_id: 'w2', block_id: 'b2' },
          ],
        }),
      },
      {
        path: '/children/{workspace}/{block}',
        handler: (_req, url) => {
          requestedPaths.push(url.pathname);
          return { body: [{ id: 1 }] };
        },
      },
    ]);

    const project = makeMultiBindingForEachProject(server.url);
    const result = await runCli(
      [
        'run',
        '--integration',
        'test_api',
        'parents',
        'children',
        '--input',
        'workspace_id=explicit-partial',
      ],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(requestedPaths).toEqual(['/children/w1/b1', '/children/w2/b2']);
  });

  it('skips a for_each child non-fatally when its parent ran but returned no rows', async () => {
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [] }) },
      { path: '/children/{token}', handler: () => ({ body: [{ id: 1 }] }) },
    ]);

    const project = makeForEachProject(server.url);
    const summaryDir = path.join(project.projectDir, 'summary');
    fs.mkdirSync(summaryDir, { recursive: true });

    // Both resources run together. The parent is legitimately empty, so the
    // child is a visible but non-fatal skip and the run still succeeds.
    const result = await runCli(
      ['run', '--integration', 'test_api', 'parents', 'children', '--output-dir', summaryDir],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    const runSummary = JSON.parse(
      fs.readFileSync(path.join(summaryDir, 'run_summary.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(runSummary).toMatchObject({
      status: 'success',
      totals: {
        resources_succeeded: 1,
        resources_skipped: 1,
        resources_failed: 0,
      },
      resources: {
        parents: expect.objectContaining({ status: 'success', records_emitted: 0 }),
        children: expect.objectContaining({ status: 'skipped' }),
      },
    });
  });

  it('fans out a for_each child over parent records when both run together', async () => {
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [{ token: 'w1' }, { token: 'w2' }] }) },
      { path: '/children/{token}', handler: () => ({ body: [{ id: 1 }] }) },
    ]);

    const project = makeForEachProject(server.url);
    const summaryDir = path.join(project.projectDir, 'summary');
    fs.mkdirSync(summaryDir, { recursive: true });

    const result = await runCli(
      ['run', '--integration', 'test_api', 'parents', 'children', '--output-dir', summaryDir],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    const runSummary = JSON.parse(
      fs.readFileSync(path.join(summaryDir, 'run_summary.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(runSummary).toMatchObject({
      status: 'success',
      totals: {
        resources_succeeded: 2,
        resources_skipped: 0,
        resources_failed: 0,
      },
      resources: {
        parents: expect.objectContaining({ status: 'success', records_emitted: 2 }),
        children: expect.objectContaining({ status: 'success', records_emitted: 2 }),
      },
    });
  });

  it('composes a static input matrix with for_each parent records', async () => {
    const requested = new Set<string>();
    let activeChildren = 0;
    let maxActiveChildren = 0;
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [{ token: 'w1' }, { token: 'w2' }] }) },
      {
        path: '/children/{token}',
        handler: async (_req, url) => {
          activeChildren += 1;
          maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
          requested.add(`${url.pathname}?${url.searchParams.get('variant')}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
          activeChildren -= 1;
          return { body: [{ id: 1 }] };
        },
      },
    ]);

    const project = makeForEachProject(server.url);
    const childPath = path.join(project.projectDir, 'resources', 'test_api', 'children.yml');
    const child = YAML.parse(fs.readFileSync(childPath, 'utf-8')) as Record<string, unknown>;
    child['input'] = {
      parent_token: { type: 'string' },
      variant: { type: 'string' },
    };
    child['api'] = {
      endpoint: '/children/${{ input.parent_token }}',
      method: 'GET',
      query_params: { variant: '${{ input.variant }}' },
    };
    child['extract'] = {
      ...(child['extract'] as Record<string, unknown>),
      incremental: { strategy: 'full_refresh' },
    };
    fs.writeFileSync(childPath, YAML.stringify(child), 'utf-8');

    const result = await runCli(
      [
        'run',
        '--integration',
        'test_api',
        'parents',
        'children',
        '--resource-input-matrices-json',
        JSON.stringify({ children: [{ variant: 'morning' }, { variant: 'evening' }] }),
        '--resource-input-matrix-concurrency-json',
        JSON.stringify({ children: 2 }),
      ],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(requested).toEqual(
      new Set([
        '/children/w1?morning',
        '/children/w1?evening',
        '/children/w2?morning',
        '/children/w2?evening',
      ])
    );
    expect(maxActiveChildren).toBe(2);
    expect(
      parseJsonLines(result.stdout).filter(
        (message) => message.type === 'SCHEMA' && message.stream === 'children'
      )
    ).toHaveLength(1);
    expect(
      parseJsonLines(result.stderr).filter(
        (message) =>
          message.event === 'progress.resource_complete' &&
          (message.attributes as Record<string, unknown> | undefined)?.resource === 'children'
      )
    ).toHaveLength(2);
  });

  it('isolates projected parent context across fan-out pagination and retries', async () => {
    const attempts = new Map<string, number>();
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [{ token: 'w1' }, { token: 'w2' }] }) },
      {
        path: '/children/{token}',
        handler: (_req, url) => {
          const token = url.pathname.split('/').at(-1)!;
          const offset = Number(url.searchParams.get('offset') ?? '0');
          const attemptKey = `${token}:${offset}`;
          const attempt = (attempts.get(attemptKey) ?? 0) + 1;
          attempts.set(attemptKey, attempt);

          // Force a retry on w1's second page while w2 is allowed to progress.
          // The retried page must retain w1's immutable lineage context.
          if (token === 'w1' && offset === 2 && attempt === 1) {
            return { status: 429, headers: { 'Retry-After': '0' }, body: { error: 'retry' } };
          }

          const records = [
            { id: offset + 1, source_token: token },
            { id: offset + 2, source_token: token },
          ];
          return { body: offset === 0 ? records : records.slice(0, 1) };
        },
      },
    ]);

    const project = makeContextProjectionForEachProject(server.url);
    const result = await runCli(
      ['run', '--integration', 'test_api', 'parents', 'children'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(attempts.get('w1:2')).toBe(2);

    const childRecords = parseJsonLines(result.stdout)
      .filter((message) => message['type'] === 'RECORD' && message['stream'] === 'children')
      .map((message) => message['record'] as Record<string, unknown>);

    expect(childRecords).toHaveLength(6);
    expect(
      childRecords
        .map((record) => ({
          id: record['id'],
          parent_token: record['parent_token'],
          source_token: record['source_token'],
        }))
        .sort((left, right) =>
          `${left.parent_token}:${left.id}`.localeCompare(`${right.parent_token}:${right.id}`)
        )
    ).toEqual([
      { id: 1, parent_token: 'w1', source_token: 'w1' },
      { id: 2, parent_token: 'w1', source_token: 'w1' },
      { id: 3, parent_token: 'w1', source_token: 'w1' },
      { id: 1, parent_token: 'w2', source_token: 'w2' },
      { id: 2, parent_token: 'w2', source_token: 'w2' },
      { id: 3, parent_token: 'w2', source_token: 'w2' },
    ]);
  });

  it('rejects invalid contextual ancestry before issuing any extraction request', async () => {
    let requestCount = 0;
    server = await createFakeHttpsServer([
      {
        path: '/parents',
        handler: () => {
          requestCount += 1;
          return { body: [{ token: 'w1' }] };
        },
      },
      {
        path: '/children/{token}',
        handler: () => {
          requestCount += 1;
          return { body: [{ id: 1 }] };
        },
      },
    ]);

    const project = makeContextProjectionForEachProject(server.url);
    const childPath = path.join(project.projectDir, 'resources', 'test_api', 'children.yml');
    const child = YAML.parse(fs.readFileSync(childPath, 'utf-8')) as Record<string, unknown>;
    const output = child['output'] as Record<string, Record<string, unknown>>;
    output['parent_token']!['from'] = { resource: 'parents', path: '$.undeclared' };
    fs.writeFileSync(childPath, YAML.stringify(child), 'utf-8');

    const result = await runCli(
      ['run', '--integration', 'test_api', 'parents', 'children'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Resource validation failed before extraction');
    expect(result.stderr).toContain('missing or opaque declared output path');
    expect(requestCount).toBe(0);
  });

  it('defers for_each STATE messages until every iteration has emitted its records', async () => {
    // Regression: one STATE per for_each iteration forced streaming loaders
    // to flush + durably load a micro-batch per parent record (one BigQuery
    // load job + MERGE per parent), serializing the pipeline behind the
    // destination. STATE messages must trail all of the child's RECORDs.
    server = await createFakeHttpsServer([
      { path: '/parents', handler: () => ({ body: [{ token: 'w1' }, { token: 'w2' }] }) },
      { path: '/children/{token}', handler: () => ({ body: [{ id: 1 }] }) },
    ]);

    const project = makeForEachProject(server.url);
    const result = await runCli(
      ['run', '--integration', 'test_api', 'parents', 'children'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    const childMessages = parseJsonLines(result.stdout)
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message['stream'] === 'children');
    const recordIndexes = childMessages
      .filter(({ message }) => message['type'] === 'RECORD')
      .map(({ index }) => index);
    const states = childMessages.filter(({ message }) => message['type'] === 'STATE');

    expect(recordIndexes).toHaveLength(2);
    // One STATE per iteration, each keeping its own partition slot…
    expect(states.map(({ message }) => message['partition']).sort()).toEqual([
      'parent_token=w1',
      'parent_token=w2',
    ]);
    // …but emitted only after ALL of the stream's records.
    const firstStateIndex = Math.min(...states.map(({ index }) => index));
    expect(firstStateIndex).toBeGreaterThan(Math.max(...recordIndexes));
  });

  it('writes JSONL files while emitting pretty stderr when requested', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/items',
        handler: () => ({ body: [{ id: 1, name: 'alpha' }] }),
      },
    ]);

    const project = makeProject(server.url);
    const result = await runCli(
      [
        '--log-format',
        'pretty',
        'run',
        '--integration',
        'test_api',
        'test_items',
        '--output',
        'file',
      ],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');

    const stderrLines = nonEmptyLines(result.stderr);
    expect(stderrLines.some((line) => line.startsWith('[info]'))).toBe(true);
    expect(() => JSON.parse(stderrLines[0]!)).toThrow();

    const outputPath = path.join(project.projectDir, 'output', 'test_items.jsonl');
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(
      parseJsonLines(fs.readFileSync(outputPath, 'utf-8')).map((message) => message.type)
    ).toEqual(['SCHEMA', 'RECORD', 'STATE']);
  });

  it('formats command failures as JSON by default and pretty text when requested', async () => {
    const projectDir = makeTempDir('extractor-cli-failure-');
    fs.writeFileSync(path.join(projectDir, 'extractor.yml'), 'integrations_dir: [\n', 'utf-8');

    const jsonResult = await runCli(['validate'], projectDir);
    expect(jsonResult.exitCode).toBe(1);
    expect(jsonResult.stdout).toBe('');
    expect(parseJsonLines(jsonResult.stderr)).toEqual([
      expect.objectContaining({
        type: 'LOG',
        level: 'error',
        message: expect.stringContaining('Invalid extractor.yml'),
      }),
    ]);

    const prettyResult = await runCli(['--log-format', 'pretty', 'validate'], projectDir);
    expect(prettyResult.exitCode).toBe(1);
    expect(prettyResult.stdout).toBe('');
    expect(prettyResult.stderr).toContain('[error]');
    expect(prettyResult.stderr).toContain('Invalid extractor.yml');
  });

  function makeProject(baseUrl: string): { projectDir: string; caCertPath: string } {
    const projectDir = makeTempDir('extractor-cli-project-');
    const caCertPath = path.join(projectDir, 'fake-ca.pem');
    const integrationSpec = makeProvider(baseUrl, { name: 'test_api' });
    const resource = makeResource({
      name: 'test_items',
      integration: 'test_api',
      endpoint: '/items',
      response: { record_path: '$' },
    });

    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'test_api'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'extractor.yml'),
      YAML.stringify({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
        state_dir: '.extractor',
        output_dir: 'output',
        default_output: 'stdout',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'integrations', 'test_api.yml'),
      YAML.stringify(integrationSpec),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'test_api', 'test_items.yml'),
      YAML.stringify(resource),
      'utf-8'
    );
    fs.writeFileSync(caCertPath, FAKE_SERVER_CERT, 'utf-8');

    return { projectDir, caCertPath };
  }

  // Scaffolds a project with a `parents` resource and a `children` resource that
  // fans out over it via extract.for_each. makeResource() doesn't pass for_each
  // through, so the specs are written as plain objects (the CLI re-parses the YAML).
  function makeForEachProject(baseUrl: string): { projectDir: string; caCertPath: string } {
    const projectDir = makeTempDir('extractor-cli-foreach-');
    const caCertPath = path.join(projectDir, 'fake-ca.pem');
    const integrationSpec = makeProvider(baseUrl, { name: 'test_api' });

    const parent = {
      spec_version: '1',
      name: 'parents',
      type: 'resource',
      integration: 'test_api',
      description: 'Parent resource',
      api: { endpoint: '/parents', method: 'GET' },
      input: {},
      output: { token: { type: 'string', path: '$.token' } },
      extract: { record_path: '$', table: { primary_key: ['token'] } },
    };

    const child = {
      spec_version: '1',
      name: 'children',
      type: 'resource',
      integration: 'test_api',
      description: 'Child resource that fans out over parents',
      api: { endpoint: '/children/${{ input.parent_token }}', method: 'GET' },
      input: { parent_token: { type: 'string' } },
      output: {
        id: { type: 'integer', path: '$.id' },
        parent_token: { type: 'string', path: '$.__input__.parent_token' },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'parents', field: 'token', input: 'parent_token' },
        table: { primary_key: ['parent_token', 'id'] },
      },
    };

    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'test_api'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'extractor.yml'),
      YAML.stringify({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
        state_dir: '.extractor',
        output_dir: 'output',
        default_output: 'stdout',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'integrations', 'test_api.yml'),
      YAML.stringify(integrationSpec),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'test_api', 'parents.yml'),
      YAML.stringify(parent),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'test_api', 'children.yml'),
      YAML.stringify(child),
      'utf-8'
    );
    fs.writeFileSync(caCertPath, FAKE_SERVER_CERT, 'utf-8');

    return { projectDir, caCertPath };
  }

  function makeContextProjectionForEachProject(baseUrl: string): {
    projectDir: string;
    caCertPath: string;
  } {
    const project = makeForEachProject(baseUrl);
    const integrationPath = path.join(project.projectDir, 'integrations', 'test_api.yml');
    const childPath = path.join(project.projectDir, 'resources', 'test_api', 'children.yml');
    const integration = YAML.parse(fs.readFileSync(integrationPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const child = YAML.parse(fs.readFileSync(childPath, 'utf-8')) as Record<string, unknown>;
    const transport = integration['transport'] as Record<string, unknown>;

    transport['retry'] = {
      retry_on: [429],
      max_retries: 1,
      backoff: 'fixed',
      retry_after_header: true,
    };
    child['api'] = {
      endpoint: '/children/${{ input.parent_token }}',
      method: 'GET',
      query_params: {
        limit: '${{ input.limit }}',
        offset: '${{ input.offset }}',
      },
    };
    child['input'] = {
      parent_token: { type: 'string' },
      limit: { type: 'integer', default: 2 },
      offset: { type: 'integer', default: 0 },
    };
    child['output'] = {
      id: { type: 'integer', path: '$.id' },
      source_token: { type: 'string', path: '$.source_token' },
      parent_token: {
        type: 'string',
        from: { resource: 'parents', path: '$.token' },
      },
    };
    child['extract'] = {
      record_path: '$',
      pagination: { type: 'offset', offset_param: 'offset', limit_param: 'limit' },
      for_each: {
        resource: 'parents',
        field: 'token',
        input: 'parent_token',
        concurrency: 2,
      },
      table: { primary_key: ['parent_token', 'id'] },
    };

    fs.writeFileSync(integrationPath, YAML.stringify(integration), 'utf-8');
    fs.writeFileSync(childPath, YAML.stringify(child), 'utf-8');
    return project;
  }

  function makeMultiBindingForEachProject(baseUrl: string): {
    projectDir: string;
    caCertPath: string;
  } {
    const project = makeForEachProject(baseUrl);
    const parentPath = path.join(project.projectDir, 'resources', 'test_api', 'parents.yml');
    const childPath = path.join(project.projectDir, 'resources', 'test_api', 'children.yml');
    const parent = YAML.parse(fs.readFileSync(parentPath, 'utf-8')) as Record<string, unknown>;
    const child = YAML.parse(fs.readFileSync(childPath, 'utf-8')) as Record<string, unknown>;
    parent['output'] = {
      workspace_id: { type: 'string', path: '$.workspace_id' },
      block_id: { type: 'string', path: '$.block_id' },
    };
    parent['extract'] = {
      record_path: '$',
      table: { primary_key: ['workspace_id', 'block_id'] },
    };
    child['api'] = {
      endpoint: '/children/${{ input.workspace_id }}/${{ input.block_id }}',
      method: 'GET',
    };
    child['input'] = {
      workspace_id: { type: 'string' },
      block_id: { type: 'string' },
    };
    child['output'] = { id: { type: 'integer', path: '$.id' } };
    child['extract'] = {
      record_path: '$',
      for_each: {
        resource: 'parents',
        bindings: [
          { field: 'workspace_id', input: 'workspace_id' },
          { field: 'block_id', input: 'block_id' },
        ],
      },
      table: { primary_key: ['id'] },
    };
    fs.writeFileSync(parentPath, YAML.stringify(parent), 'utf-8');
    fs.writeFileSync(childPath, YAML.stringify(child), 'utf-8');
    return project;
  }

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }
});

function parseJsonLines(output: string): Array<Record<string, unknown>> {
  return nonEmptyLines(output).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function nonEmptyLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runCli(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env['NODE_BINARY'] ?? 'node',
      ['--import', tsxLoader, cliEntry, ...args],
      {
        cwd,
        env: { ...process.env, ...envOverrides },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });
  });
}
