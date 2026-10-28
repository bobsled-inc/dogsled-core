import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadProjectConfig, resolveConfig } from '../../src/config.js';
import { CommandError } from '../../src/errors.js';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadProjectConfig', () => {
    it.each([10, 120, 600])('preserves a checkpoint lease of %i seconds', (seconds) => {
      fs.writeFileSync(
        path.join(tmpDir, 'model-spec.yml'),
        `checkpoint_store: {integration: warehouse, schema: checkpoints, lease_seconds: ${seconds}}`
      );
      const { config } = loadProjectConfig(tmpDir);
      expect(resolveConfig({}, config).checkpointStore?.lease_seconds).toBe(seconds);
    });

    it.each([9, 601, 10.5, '"120"', 'null'])(
      'rejects an invalid checkpoint lease: %s',
      (seconds) => {
        fs.writeFileSync(
          path.join(tmpDir, 'model-spec.yml'),
          `checkpoint_store: {integration: warehouse, schema: checkpoints, lease_seconds: ${seconds}}`
        );
        expect(() => loadProjectConfig(tmpDir)).toThrow(CommandError);
      }
    );
    it('preserves warehouse checkpoint configuration during project resolution', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'model-spec.yml'),
        'checkpoint_store:\n  integration: analytics_warehouse\n  schema: track_checkpoints\n'
      );
      const { config } = loadProjectConfig(tmpDir);
      expect(resolveConfig({}, config).checkpointStore).toEqual({
        integration: 'analytics_warehouse',
        schema: 'track_checkpoints',
      });
    });

    it.each([
      'checkpoint_store: {}',
      'checkpoint_store: {integration: warehouse}',
      'checkpoint_store: {integration: "", schema: checkpoints}',
      'checkpoint_store: {integration: warehouse, schema: " "}',
      'checkpoint_store: {integration: warehouse, schema: checkpoints, password: secret}',
      'checkpoint_store: {integration: warehouse, schema: checkpoints, fallback: local}',
    ])('rejects invalid checkpoint configuration: %s', (yaml) => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), yaml);
      expect(() => loadProjectConfig(tmpDir)).toThrow(CommandError);
    });

    it('returns null when no config file exists', () => {
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toBeNull();
    });

    it('returns null for empty config file', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), '', 'utf-8');
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toBeNull();
    });

    it('parses directory overrides', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'model-spec.yml'),
        'sources_dir: src\nmodels_dir: transforms\nintegrations_dir: connections',
        'utf-8'
      );
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toEqual({
        sources_dir: 'src',
        models_dir: 'transforms',
        integrations_dir: 'connections',
      });
    });

    it('accepts targets_dir override', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'targets_dir: envs', 'utf-8');
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toEqual({ targets_dir: 'envs' });
    });

    it('accepts entity_graph_dir override from model-spec.yml', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'entity_graph_dir: graph', 'utf-8');
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toEqual({ entity_graph_dir: 'graph' });
      expect(resolveConfig({}, config).entityGraphDir).toBe('graph');
    });

    it('accepts legacy mdm_dir as an alias for entity_graph_dir', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'mdm_dir: mdm_specs', 'utf-8');
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toEqual({ entity_graph_dir: 'mdm_specs' });
      expect(resolveConfig({}, config).entityGraphDir).toBe('mdm_specs');
      expect(resolveConfig({}, config).mdmDir).toBe('mdm_specs');
    });

    it('prefers entity_graph_dir when both directory keys are present', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'model-spec.yml'),
        'mdm_dir: mdm_specs\nentity_graph_dir: graph_specs',
        'utf-8'
      );
      const { config } = loadProjectConfig(tmpDir);
      expect(config).toEqual({ entity_graph_dir: 'graph_specs' });
      expect(resolveConfig({}, config).entityGraphDir).toBe('graph_specs');
      expect(resolveConfig({}, config).mdmDir).toBe('graph_specs');
    });

    it('throws a CommandError for removed top-level dialect field', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'dialect: snowflake', 'utf-8');
      let caught: unknown;
      try {
        loadProjectConfig(tmpDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CommandError);
      expect((caught as CommandError).exitCode).toBe(2);
      expect((caught as CommandError).message).toContain('"dialect"');
    });

    it('throws a CommandError for removed top-level schema field', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'schema: PUBLIC', 'utf-8');
      let caught: unknown;
      try {
        loadProjectConfig(tmpDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CommandError);
      expect((caught as CommandError).exitCode).toBe(2);
      expect((caught as CommandError).message).toContain('"schema"');
    });

    it('throws when both removed fields are present', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'model-spec.yml'),
        'dialect: bigquery\nschema: my_dataset',
        'utf-8'
      );
      let caught: unknown;
      try {
        loadProjectConfig(tmpDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CommandError);
      expect((caught as CommandError).exitCode).toBe(2);
      expect((caught as CommandError).message).toContain('"dialect"');
      expect((caught as CommandError).message).toContain('"schema"');
    });

    it('throws on unknown keys', () => {
      fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'unknown_key: value', 'utf-8');
      expect(() => loadProjectConfig(tmpDir)).toThrow('Invalid model-spec.yml');
    });
  });

  describe('resolveConfig', () => {
    it('uses defaults when no flags or config', () => {
      const result = resolveConfig({}, null);
      expect(result).toEqual({
        dialect: 'snowflake',
        schema: 'PUBLIC',
        sourcesDir: 'sources',
        modelsDir: 'models',
        seedsDir: 'seeds',
        entityGraphDir: 'entity-graph',
        mdmDir: 'entity-graph',
        integrationsDir: 'integrations',
        targetsDir: 'targets',
        metricsDir: 'metrics',
        relationshipsDir: 'relationships',
        vqsDir: 'vqs',
      });
    });

    it('resolves metrics/relationships/vqs directory overrides from config file', () => {
      const result = resolveConfig({}, { metrics_dir: 'm', relationships_dir: 'r', vqs_dir: 'v' });
      expect(result.metricsDir).toBe('m');
      expect(result.relationshipsDir).toBe('r');
      expect(result.vqsDir).toBe('v');
    });

    it('config directory overrides flow through', () => {
      const result = resolveConfig(
        {},
        { sources_dir: 'src', entity_graph_dir: 'graph', integrations_dir: 'conns' }
      );
      expect(result.sourcesDir).toBe('src');
      expect(result.entityGraphDir).toBe('graph');
      expect(result.integrationsDir).toBe('conns');
    });

    it('CLI flags take precedence over config', () => {
      const result = resolveConfig(
        {
          sourcesDir: 'override',
          integrationsDir: 'override_conns',
          entityGraphDir: 'override_graph',
          mdmDir: 'legacy_override',
        },
        {
          sources_dir: 'config_src',
          integrations_dir: 'config_conns',
          entity_graph_dir: 'config_graph',
        }
      );
      expect(result.sourcesDir).toBe('override');
      expect(result.integrationsDir).toBe('override_conns');
      expect(result.entityGraphDir).toBe('override_graph');
      expect(result.mdmDir).toBe('override_graph');
    });

    it('dialect and schema fall through from cliFlags for Entity Graph callers', () => {
      const result = resolveConfig({ dialect: 'bigquery', schema: 'my_dataset' }, null);
      expect(result.dialect).toBe('bigquery');
      expect(result.schema).toBe('my_dataset');
    });
  });
});
