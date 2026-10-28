import { describe, expect, it } from 'vitest';

import { getResourcePath, listResourceFiles, readYamlFile } from '../src/loader.js';
import { ResourceSpecSchema } from '../src/validate.js';

interface OutputFieldLike {
  path?: string;
  semantic_role?: string;
  items?: OutputFieldLike;
  properties?: Record<string, OutputFieldLike>;
}

function githubResource(name: string): Record<string, unknown> {
  return readYamlFile(getResourcePath('github', name)) as Record<string, unknown>;
}

function expectBindings(
  resourceName: string,
  parentResource: string,
  expectedBindings: Array<{ field: string; input: string; source?: 'input' | 'output' }>
): void {
  const resource = githubResource(resourceName);
  const parsed = ResourceSpecSchema.parse(resource);
  const forEach = parsed.extract.for_each;

  expect(forEach).toBeDefined();
  expect(forEach?.resource).toBe(parentResource);
  const actualBindings =
    forEach && 'bindings' in forEach
      ? forEach.bindings.map((binding) => ({
          ...binding,
          source: binding.source ?? 'output',
        }))
      : [];
  expect(actualBindings).toEqual(
    expectedBindings.map((binding) => ({
      ...binding,
      source: binding.source ?? 'output',
    }))
  );
}

function collectMissingSemanticRoles(
  fields: Record<string, OutputFieldLike>,
  prefix = 'output'
): string[] {
  const missing: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const fieldPath = `${prefix}.${name}`;
    if (!field.semantic_role) {
      missing.push(fieldPath);
    }
    if (field.items) {
      missing.push(...collectMissingSemanticRoles({ items: field.items }, fieldPath));
    }
    if (field.properties) {
      missing.push(...collectMissingSemanticRoles(field.properties, fieldPath));
    }
  }
  return missing;
}

function expectRepoContextOutputs(resourceName: string): void {
  const resource = ResourceSpecSchema.parse(githubResource(resourceName));
  const output = resource.output as Record<string, OutputFieldLike>;

  expect(output['repository_owner']).toMatchObject({
    path: '$.__input__.owner',
    semantic_role: 'name',
  });
  expect(output['repository_name']).toMatchObject({
    path: '$.__input__.repo',
    semantic_role: 'name',
  });
  expect(output['repository_full_name']).toMatchObject({
    path: '$.__input__.repository_full_name',
    semantic_role: 'identifier',
  });
}

function expectPrimaryKey(resourceName: string, expectedPrimaryKey: string[]): void {
  const resource = ResourceSpecSchema.parse(githubResource(resourceName));
  expect(resource.extract.table?.primary_key).toEqual(expectedPrimaryKey);
}

const githubResourceNames = listResourceFiles('github');

const repoFanoutResources = [
  'branches',
  'commits',
  'dependency_graph_sbom',
  'dependency_review',
  'deployments',
  'environments',
  'issues',
  'labels',
  'milestones',
  'pull_requests',
  'releases',
  'workflow_runs',
  'workflows',
];

const repoContextResources = [
  ...repoFanoutResources,
  'dependency_graph_manifests',
  'check_runs',
  'pull_request_reviews',
];

describe('github repo fanout resources', () => {
  it('declares semantic roles for every GitHub output field', () => {
    const missing = githubResourceNames.flatMap((resourceName) => {
      const resource = ResourceSpecSchema.parse(githubResource(resourceName));
      return collectMissingSemanticRoles(
        resource.output as Record<string, OutputFieldLike>,
        resourceName
      );
    });

    expect(missing).toEqual([]);
  });

  it('declares every for_each binding input on the child resource', () => {
    const missing = githubResourceNames.flatMap((resourceName) => {
      const resource = ResourceSpecSchema.parse(githubResource(resourceName));
      const forEach = resource.extract.for_each;
      if (!forEach) {
        return [];
      }

      const bindings =
        'bindings' in forEach ? forEach.bindings : [{ field: forEach.field, input: forEach.input }];
      const declaredInputs = new Set(Object.keys(resource.input));
      return bindings
        .filter((binding) => !declaredInputs.has(binding.input))
        .map((binding) => `${resourceName}.${binding.input}`);
    });

    expect(missing).toEqual([]);
  });

  it('filters repos from the optional repo_names input', () => {
    const repos = ResourceSpecSchema.parse(githubResource('repos'));

    expect(repos.input['repo_names']).toMatchObject({ type: 'string' });
    expect(repos.extract.record_filters).toEqual([
      { field: 'name', input: 'repo_names', operator: 'in', delimiter: ',' },
    ]);
  });

  it('fans pull_requests and commits out from repos', () => {
    expectBindings('pull_requests', 'repos', [
      { field: 'owner_login', input: 'owner' },
      { field: 'name', input: 'repo' },
      { field: 'full_name', input: 'repository_full_name' },
    ]);
    expectBindings('commits', 'repos', [
      { field: 'owner_login', input: 'owner' },
      { field: 'name', input: 'repo' },
      { field: 'full_name', input: 'repository_full_name' },
    ]);
  });

  it('fans every repository child resource out from repos with explicit repo context', () => {
    for (const resourceName of repoFanoutResources) {
      expectBindings(resourceName, 'repos', [
        { field: 'owner_login', input: 'owner' },
        { field: 'name', input: 'repo' },
        { field: 'full_name', input: 'repository_full_name' },
      ]);
    }

    expectBindings('dependency_graph_manifests', 'repos', [
      { field: 'node_id', input: 'repository_id' },
      { field: 'owner_login', input: 'owner' },
      { field: 'name', input: 'repo' },
      { field: 'full_name', input: 'repository_full_name' },
    ]);
  });

  it('exposes repository context fields sourced from for_each input context', () => {
    for (const resourceName of repoContextResources) {
      expectRepoContextOutputs(resourceName);
    }
  });

  it('propagates parent pull request owner, repo, and number into pull_request_reviews', () => {
    expectBindings('pull_request_reviews', 'pull_requests', [
      { field: 'owner', input: 'owner', source: 'input' },
      { field: 'repo', input: 'repo', source: 'input' },
      { field: 'repository_full_name', input: 'repository_full_name', source: 'input' },
      { field: 'id', input: 'pull_request_id' },
      { field: 'number', input: 'pull_number' },
    ]);

    const reviews = ResourceSpecSchema.parse(githubResource('pull_request_reviews'));
    expect(reviews.output['pull_request_id']).toMatchObject({
      path: '$.__input__.pull_request_id',
      semantic_role: 'entity_id',
    });
    expect(reviews.output['pull_request_number']).toMatchObject({
      path: '$.__input__.pull_number',
      semantic_role: 'identifier',
    });
  });

  it('fans check_runs out from commits while retaining repository context', () => {
    expectBindings('check_runs', 'commits', [
      { field: 'owner', input: 'owner', source: 'input' },
      { field: 'repo', input: 'repo', source: 'input' },
      { field: 'repository_full_name', input: 'repository_full_name', source: 'input' },
      { field: 'sha', input: 'ref' },
    ]);
  });

  it('uses repo-scoped primary keys where child identifiers can collide across repos', () => {
    expectPrimaryKey('branches', ['repository_full_name', 'name']);
    expectPrimaryKey('commits', ['repository_full_name', 'sha']);
    expectPrimaryKey('dependency_review', [
      'repository_full_name',
      'comparison_basehead',
      'manifest',
      'name',
      'change_type',
      'version',
      'scope',
    ]);
  });
});
