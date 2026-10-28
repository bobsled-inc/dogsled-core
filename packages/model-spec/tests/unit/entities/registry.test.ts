import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProject } from '@bobsled-inc/project-index';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadEntityRelationshipsDirectory,
  loadIndexedMetadataRegistry,
  loadMetadataRegistry,
  loadMetricsDirectory,
  loadRelationshipsDirectory,
  loadVqsDirectory,
} from '../../../src/entities/registry.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/entities', import.meta.url));

describe('loadMetricsDirectory', () => {
  it('loads two metrics from the fixtures dir', async () => {
    const metrics = await loadMetricsDirectory(FIXTURE_ROOT, 'metrics');
    expect([...metrics.keys()].sort()).toEqual(['order_conversion_rate', 'orders_total']);
    expect(metrics.get('orders_total')?.expression).toBe('SUM(amount)');
  });

  it('returns an empty map when the directory does not exist', async () => {
    const metrics = await loadMetricsDirectory(FIXTURE_ROOT, 'nonexistent');
    expect(metrics.size).toBe(0);
  });

  it('throws CommandError(2) on invalid metric file', async () => {
    await expect(loadMetricsDirectory(FIXTURE_ROOT, 'invalid-metric')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });
});

describe('loadRelationshipsDirectory', () => {
  it('loads only Model Spec relationship fixtures', async () => {
    const relationships = await loadRelationshipsDirectory(FIXTURE_ROOT, 'relationships');
    expect([...relationships.keys()]).toEqual(['orders_to_customers']);
    expect(relationships.get('orders_to_customers')?.join_type).toBe('left');
  });

  it('returns an empty map on missing directory', async () => {
    const relationships = await loadRelationshipsDirectory(FIXTURE_ROOT, 'nope');
    expect(relationships.size).toBe(0);
  });

  it('throws CommandError(2) on invalid relationship file', async () => {
    await expect(
      loadRelationshipsDirectory(FIXTURE_ROOT, 'invalid-relationship')
    ).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });
});

describe('loadEntityRelationshipsDirectory', () => {
  it('loads only entity relationship fixtures', async () => {
    const relationships = await loadEntityRelationshipsDirectory(FIXTURE_ROOT, 'relationships');
    expect([...relationships.keys()]).toEqual(['works_at']);
    expect(relationships.get('works_at')?.left_entity).toBe('contact');
  });

  it('returns an empty map on missing directory', async () => {
    const relationships = await loadEntityRelationshipsDirectory(FIXTURE_ROOT, 'nope');
    expect(relationships.size).toBe(0);
  });

  it('throws CommandError(2) on invalid entity relationship file', async () => {
    await expect(
      loadEntityRelationshipsDirectory(FIXTURE_ROOT, 'invalid-entity-relationship')
    ).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });
});

describe('loadVqsDirectory', () => {
  it('loads the fixture VQ', async () => {
    const vqs = await loadVqsDirectory(FIXTURE_ROOT, 'vqs');
    expect([...vqs.keys()]).toEqual(['top_customers']);
    expect(vqs.get('top_customers')?.parameters).toHaveLength(1);
  });

  it('returns an empty map on missing directory', async () => {
    const vqs = await loadVqsDirectory(FIXTURE_ROOT, 'nope');
    expect(vqs.size).toBe(0);
  });

  it('throws CommandError(2) on invalid VQ file', async () => {
    await expect(loadVqsDirectory(FIXTURE_ROOT, 'invalid-vq')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });
});

describe('loadMetadataRegistry', () => {
  it('loads all three registries in one call', async () => {
    const registry = await loadMetadataRegistry(FIXTURE_ROOT, {
      metricsDir: 'metrics',
      relationshipsDir: 'relationships',
      vqsDir: 'vqs',
    });
    expect(registry.metrics.size).toBe(2);
    expect(registry.relationships.size).toBe(1);
    expect(registry.entityRelationships.size).toBe(1);
    expect(registry.vqs.size).toBe(1);
  });

  it('returns empty maps when no entity directories exist', async () => {
    const registry = await loadMetadataRegistry(FIXTURE_ROOT, {
      metricsDir: 'missing-m',
      relationshipsDir: 'missing-r',
      vqsDir: 'missing-v',
    });
    expect(registry.metrics.size).toBe(0);
    expect(registry.relationships.size).toBe(0);
    expect(registry.entityRelationships.size).toBe(0);
    expect(registry.vqs.size).toBe(0);
  });
});

describe('loadIndexedMetadataRegistry', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'dogsled-model-spec-metadata-'));
    roots.push(root);
    for (const [target, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, target)), { recursive: true });
      copyFileSync(join(FIXTURE_ROOT, source), join(root, target));
    }
    return root;
  }

  it('loads every entity kind from any folder layout', () => {
    const root = project({
      'shop/orders/total.yml': 'metrics/orders_total.yml',
      'shop/orders/conversion.yml': 'metrics/order_conversion_rate.yml',
      'shop/joins/orders.yml': 'relationships/orders_to_customers.yml',
      'people/works_at.yml': 'relationships/works_at.entity-relationship.yml',
      'shop/questions/top.yml': 'vqs/top_customers.yml',
    });
    const registry = loadIndexedMetadataRegistry(scanProject(root));
    expect([...registry.metrics.keys()].sort()).toEqual(['order_conversion_rate', 'orders_total']);
    expect(registry.relationships.size).toBe(1);
    expect(registry.entityRelationships.size).toBe(1);
    expect(registry.vqs.size).toBe(1);
  });

  it('returns empty maps when the project declares no entities', () => {
    const registry = loadIndexedMetadataRegistry(scanProject(project({})));
    expect(registry.metrics.size).toBe(0);
    expect(registry.relationships.size).toBe(0);
    expect(registry.entityRelationships.size).toBe(0);
    expect(registry.vqs.size).toBe(0);
  });

  it('names both files when two entities share a name', () => {
    const root = project({
      'a/total.yml': 'metrics/orders_total.yml',
      'b/total.yml': 'metrics/orders_total.yml',
    });
    expect(() => loadIndexedMetadataRegistry(scanProject(root))).toThrow(
      /Duplicate metric name "orders_total" in .*a\/total\.yml and .*b\/total\.yml/
    );
  });
});
