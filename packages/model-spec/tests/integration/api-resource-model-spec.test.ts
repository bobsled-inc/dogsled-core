import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildDag } from '../../src/compiler/dag.js';
import { compileAll } from '../../src/compiler/orchestrator.js';
import { buildModelRegistry, buildSourceRegistry } from '../../src/compiler/parser.js';

describe('Model Spec compile — api_resource sources', () => {
  it('emits sources.<name> for a model referencing an api_resource source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bobsled-model-spec-api-'));
    await mkdir(join(root, 'sources'), { recursive: true });
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(
      join(root, 'sources', 'issues.yml'),
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
schema:
  columns:
    - { name: id, type: INTEGER }
`,
      'utf8'
    );
    await writeFile(
      join(root, 'models', 'stg_issues.yml'),
      `spec_version: '0.2'
name: stg_issues
type: model
description: Staged API issues.
grain: issue_id
source: { ref: github_prod.issues }
columns:
  - { name: issue_id, expr: id }
materialization: { type: view }
`,
      'utf8'
    );

    const sourceResult = buildSourceRegistry(join(root, 'sources'));
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;
    const dagResult = buildDag([join(root, 'models', 'stg_issues.yml')]);
    expect(dagResult.ok).toBe(true);
    if (!dagResult.ok) return;
    const modelRegistry = buildModelRegistry(['stg_issues'], 'analytics', 'duckdb');

    const results = compileAll(dagResult.order, sourceResult.registry, modelRegistry, {
      dialect: 'duckdb',
      targetSchema: 'analytics',
      entryRegistry: sourceResult.entryRegistry,
    });

    expect(results[0]).toEqual(expect.objectContaining({ ok: true }));
    const first = results[0];
    expect(first?.ok ? first.sql : '').toContain('FROM "sources"."issues"');
  });
});
