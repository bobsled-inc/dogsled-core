import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { indexProjectFiles, scanProject } from '@bobsled-inc/project-index';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCommandContext,
  findAllAvailableIntegrations,
  findIntegrationFile,
  findResourceFiles,
  loadIntegrationSpec,
  loadNamedResource,
  loadResourceSpec,
  parseGlobalFlags,
  parsePositiveInt,
  unownedProjectResources,
} from '../../src/commands/common.js';
import { makeResource } from '../helpers/fixtures.js';

describe('command helpers', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-common-'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The project lives beside, not around, the bundled catalog, as it does when
  // BOBSLED_CORE_BUNDLED_INTEGRATIONS_DIR points at an installed Dogsled package.
  const projectDir = () => path.join(tmpDir, 'project');
  const project = () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    return scanProject(projectDir());
  };
  const lookup = (bundledIntegrationsDir: string | null = null, resourcesFolder = 'resources') => ({
    project: project(),
    resourcesFolder,
    bundledIntegrationsDir,
  });

  it('rejects paths that escape through a symlinked missing ancestor', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-outside-'));
    // A hidden link: the project index never enters it, so the output_dir
    // containment check is what must catch the escape.
    fs.symlinkSync(outsideDir, path.join(tmpDir, '.link'), 'dir');
    fs.writeFileSync(
      path.join(tmpDir, 'extractor.yml'),
      YAML.stringify({ output_dir: '.link/missing/child' }),
      'utf-8'
    );

    process.chdir(tmpDir);

    expect(() => buildCommandContext(parseGlobalFlags({}))).toThrow(
      'output_dir ".link/missing/child" resolves outside project root.'
    );

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('normalizes stat and read failures into CommandError', () => {
    expect(() => loadIntegrationSpec(path.join(tmpDir, 'missing.yml'))).toThrow(
      /Unable to inspect integration spec .*missing\.yml/
    );

    const directoryPath = path.join(tmpDir, 'resource-dir');
    fs.mkdirSync(directoryPath);
    expect(() => loadResourceSpec(directoryPath)).toThrow(
      /Unable to read resource spec .*resource-dir/
    );
  });

  it('formats integration schema failures with nested union details', () => {
    const integrationPath = path.join(tmpDir, 'smartlead.yml');
    fs.writeFileSync(
      integrationPath,
      YAML.stringify({
        spec_version: '2',
        type: 'source',
        name: 'smartlead',
        default_transport: 'warehouse',
        transports: [
          {
            id: 'warehouse',
            type: 'sql_postgres',
            connection: {},
            auth: {},
          },
        ],
      }),
      'utf-8'
    );

    expect(() => loadIntegrationSpec(integrationPath)).toThrow(
      /Invalid integration spec at .*smartlead\.yml[\s\S]*transports\.0\.connection\.host_env[\s\S]*transports\.0\.auth\.type/
    );
  });

  it('points managed HTTP source overrides at an invalid base_url', () => {
    const integrationPath = path.join(tmpDir, 'smartlead.yml');
    fs.writeFileSync(
      integrationPath,
      YAML.stringify({
        auth_env_vars: ['SMARTLEAD_API_KEY'],
        spec_version: '2',
        type: 'source',
        name: 'smartlead',
        dogsled_connection_ref: 'smartlead',
        dogsled_source_kind: 'smartlead',
        transports: [
          {
            id: 'smartlead_default',
            type: 'http',
            base_url: '',
            auth: { type: 'bearer', token: '${{ env.SMARTLEAD_API_KEY }}' },
          },
        ],
        default_transport: 'smartlead_default',
      }),
      'utf-8'
    );

    let thrown: unknown;
    try {
      loadIntegrationSpec(integrationPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(
      /Invalid integration spec at .*smartlead\.yml[\s\S]*transports\.0\.base_url: Must be an absolute HTTPS URL/
    );
    // Heuristic guard: sibling MCP transport variants must not bleed into the
    // diagnostics now that the user has clearly picked the HTTP arm.
    expect(message).not.toMatch(/expected MCP (HTTP|stdio) transport/i);
  });

  it('rejects duplicate resource names for the same integration', () => {
    const resourcesDir = path.join(projectDir(), 'resources');
    const bundledSourcesDir = path.join(tmpDir, 'bundled');
    const resourceDir = path.join(resourcesDir, 'github');
    fs.mkdirSync(resourceDir, { recursive: true });
    fs.mkdirSync(path.join(bundledSourcesDir, 'github', 'resources'), { recursive: true });

    const resource = makeResource({
      name: 'issues',
      integration: 'github',
    });

    fs.writeFileSync(path.join(resourceDir, 'issues.yml'), YAML.stringify(resource), 'utf-8');
    fs.writeFileSync(path.join(resourceDir, 'issues_copy.yml'), YAML.stringify(resource), 'utf-8');
    fs.writeFileSync(
      path.join(bundledSourcesDir, 'github', 'resources', 'issues.yml'),
      YAML.stringify(resource),
      'utf-8'
    );

    expect(() => loadNamedResource(lookup(bundledSourcesDir), 'github', 'issues')).toThrow(
      'Resource "issues" is defined multiple times for integration "github": resources/github/issues.yml, resources/github/issues_copy.yml.'
    );
  });

  it('names duplicate resources by project path for an in-memory index', () => {
    const resource = YAML.stringify(makeResource({ name: 'issues', integration: 'github' }));
    for (const folder of ['a', 'b']) {
      fs.mkdirSync(path.join(tmpDir, folder, 'github'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, folder, 'github', 'issues.yml'), resource, 'utf-8');
    }
    process.chdir(tmpDir);
    const inMemory = indexProjectFiles([
      { path: 'a/github/issues.yml', content: resource },
      { path: 'b/github/issues.yml', content: resource },
    ]);

    expect(() =>
      loadNamedResource(
        { project: inMemory, resourcesFolder: 'resources', bundledIntegrationsDir: null },
        'github',
        'issues'
      )
    ).toThrow(
      'Resource "issues" is defined multiple times for integration "github": a/github/issues.yml, b/github/issues.yml.'
    );
  });

  it('merges local resource overrides with bundled siblings by declared resource name', () => {
    const resourcesDir = path.join(projectDir(), 'resources');
    const bundledSourcesDir = path.join(tmpDir, 'bundled');
    const localResourceDir = path.join(resourcesDir, 'posthog');
    const bundledResourceDir = path.join(bundledSourcesDir, 'posthog', 'resources');
    fs.mkdirSync(localResourceDir, { recursive: true });
    fs.mkdirSync(path.join(bundledResourceDir, 'events'), { recursive: true });

    const localEvents = makeResource({
      name: 'events',
      integration: 'posthog',
      endpoint: '/local-events',
    });
    const bundledEvents = makeResource({
      name: 'events',
      integration: 'posthog',
      endpoint: '/bundled-events',
    });

    // Use a filename that differs from the logical name to guard against
    // accidentally implementing precedence by basename rather than spec.name.
    const localEventsPath = path.join(localResourceDir, 'events-override.yml');
    fs.writeFileSync(localEventsPath, YAML.stringify(localEvents), 'utf-8');
    fs.writeFileSync(
      path.join(bundledResourceDir, 'events', 'mcp.yaml'),
      YAML.stringify(bundledEvents),
      'utf-8'
    );

    const siblingNames = [
      'organizations',
      'projects',
      'persons',
      'event_definitions',
      'feature_flags',
    ];
    for (const name of siblingNames) {
      fs.writeFileSync(
        path.join(bundledResourceDir, `${name}.yml`),
        YAML.stringify(makeResource({ name, integration: 'posthog' })),
        'utf-8'
      );
    }

    const files = findResourceFiles(lookup(bundledSourcesDir), 'posthog');
    expect(files).toHaveLength(siblingNames.length + 1);
    expect(files).toContain(localEventsPath);
    expect(files).not.toContain(path.join(bundledResourceDir, 'events', 'mcp.yaml'));
    for (const name of siblingNames) {
      expect(files).toContain(path.join(bundledResourceDir, `${name}.yml`));
    }

    expect(loadNamedResource(lookup(bundledSourcesDir), 'posthog', 'events')).toMatchObject({
      name: 'events',
      api: { endpoint: '/local-events' },
    });
    expect(loadNamedResource(lookup(bundledSourcesDir), 'posthog', 'projects')).toMatchObject({
      name: 'projects',
      api: { endpoint: '/items' },
    });
  });

  it('owns untyped-owner resources through a configured resources folder', () => {
    const resourceDir = path.join(projectDir(), 'connectors', 'stripe');
    fs.mkdirSync(resourceDir, { recursive: true });
    const customersPath = path.join(resourceDir, 'customers.yml');
    const { integration: _owner, ...customers } = makeResource({ name: 'customers' });
    fs.writeFileSync(customersPath, YAML.stringify(customers), 'utf-8');

    expect(findResourceFiles(lookup(null, 'connectors'), 'stripe')).toEqual([customersPath]);
    expect(findResourceFiles(lookup(), 'stripe')).toEqual([]);
    expect(unownedProjectResources(lookup(null, 'connectors'))).toEqual([]);
    expect(unownedProjectResources(lookup())).toEqual(['connectors/stripe/customers.yml']);
  });

  it('loads nested source resources by spec name without legacy integration field', () => {
    const resourcesDir = path.join(projectDir(), 'resources');
    const resourceDir = path.join(resourcesDir, 'linear', 'issues');
    fs.mkdirSync(resourceDir, { recursive: true });

    const resource = makeResource({
      name: 'issues_mcp',
      via: 'mcp',
    });
    delete (resource as Record<string, unknown>)['integration'];
    delete (resource as Record<string, unknown>)['spec_version'];

    fs.writeFileSync(path.join(resourceDir, 'mcp.yml'), YAML.stringify(resource), 'utf-8');

    expect(loadNamedResource(lookup(), 'linear', 'issues_mcp').name).toBe('issues_mcp');
  });

  it('recursively discovers nested bundled source resources', () => {
    const localResourcesDir = path.join(projectDir(), 'resources');
    const bundledSourcesDir = path.join(tmpDir, 'bundled');
    const bundledResourceDir = path.join(bundledSourcesDir, 'linear', 'resources');

    fs.mkdirSync(path.join(localResourcesDir, 'linear'), { recursive: true });
    fs.mkdirSync(path.join(bundledResourceDir, 'teams'), { recursive: true });
    fs.mkdirSync(path.join(bundledResourceDir, 'issues'), { recursive: true });
    fs.mkdirSync(path.join(bundledResourceDir, '_drafts'), { recursive: true });

    fs.writeFileSync(
      path.join(bundledResourceDir, 'comments.yml'),
      YAML.stringify(makeResource({ name: 'comments', integration: 'linear' })),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(bundledResourceDir, 'teams', 'mcp.yml'),
      YAML.stringify(makeResource({ name: 'teams_mcp', integration: 'linear' })),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(bundledResourceDir, 'issues', 'graphql.yaml'),
      YAML.stringify(makeResource({ name: 'issues_graphql', integration: 'linear' })),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(bundledResourceDir, '_drafts', 'ignored.yml'),
      'name: ignored\n',
      'utf-8'
    );

    expect(
      findResourceFiles(lookup(bundledSourcesDir), 'linear').map((filePath) =>
        path.relative(bundledResourceDir, filePath)
      )
    ).toEqual(['comments.yml', 'issues/graphql.yaml', 'teams/mcp.yml']);
  });

  it('gives an actionable diagnostic for an un-indented multi-line quoted scalar (B3)', () => {
    const resourcePath = path.join(tmpDir, 'broken.yml');
    // A single-quoted scalar whose continuation lines sit flush at column 0 —
    // the classic "pasted a code block into description" footgun. The raw yaml
    // error is the opaque "Missing closing 'quote at line N".
    fs.writeFileSync(
      resourcePath,
      ['type: resource', 'name: demo', "description: 'line one", 'still going', "closed'", ''].join(
        '\n'
      ),
      'utf-8'
    );

    let thrown: unknown;
    try {
      loadResourceSpec(resourcePath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/Missing closing .?quote/i);
    expect(message).toMatch(/block scalar/i);
    expect(message).toMatch(/\|-/);
  });

  it('rejects unsafe numeric limits', () => {
    const unsafe = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

    expect(parsePositiveInt('42')).toBe(42);
    expect(() => parsePositiveInt(unsafe)).toThrow(
      `Expected a positive integer, received "${unsafe}"`
    );
  });

  it('lists both local and bundled integrations without duplicates', () => {
    const localIntegrationsDir = path.join(projectDir(), 'integrations');
    const bundledIntegrationsDir = path.join(tmpDir, 'bundled');

    fs.mkdirSync(localIntegrationsDir, { recursive: true });
    fs.mkdirSync(path.join(bundledIntegrationsDir, 'github'), { recursive: true });
    fs.mkdirSync(path.join(bundledIntegrationsDir, 'stripe'), { recursive: true });

    fs.writeFileSync(
      path.join(localIntegrationsDir, 'github.yml'),
      "spec_version: '2'\ntype: integration\nname: github\n",
      'utf-8'
    );
    fs.writeFileSync(
      path.join(bundledIntegrationsDir, 'github', 'source.yml'),
      'name: github\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(bundledIntegrationsDir, 'stripe', 'source.yml'),
      'name: stripe\n',
      'utf-8'
    );

    expect(findAllAvailableIntegrations(project(), bundledIntegrationsDir)).toEqual([
      'github',
      'stripe',
    ]);
  });

  it('lists bundled sources using every supported spec filename', () => {
    const localIntegrationsDir = path.join(projectDir(), 'integrations');
    const bundledIntegrationsDir = path.join(tmpDir, 'bundled');

    fs.mkdirSync(localIntegrationsDir, { recursive: true });
    fs.mkdirSync(path.join(bundledIntegrationsDir, 'source_yaml'), { recursive: true });
    fs.mkdirSync(path.join(bundledIntegrationsDir, 'legacy'), { recursive: true });

    fs.writeFileSync(
      path.join(bundledIntegrationsDir, 'source_yaml', 'source.yaml'),
      'name: source_yaml\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(bundledIntegrationsDir, 'legacy', 'integration.yml'),
      'name: legacy\n',
      'utf-8'
    );

    expect(findAllAvailableIntegrations(project(), bundledIntegrationsDir)).toEqual([
      'legacy',
      'source_yaml',
    ]);
    expect(findIntegrationFile(project(), 'source_yaml', bundledIntegrationsDir)).toBe(
      path.join(bundledIntegrationsDir, 'source_yaml', 'source.yaml')
    );
    expect(findIntegrationFile(project(), 'legacy', bundledIntegrationsDir)).toBe(
      path.join(bundledIntegrationsDir, 'legacy', 'integration.yml')
    );
  });
});
