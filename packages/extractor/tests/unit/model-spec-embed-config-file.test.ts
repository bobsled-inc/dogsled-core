import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadEmbedConfigFile,
  resolveResourceEmbedConfig,
} from '../../src/model-spec/embed-config-file.js';

function writeTempJson(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'embed-config-'));
  const path = join(dir, 'embed.json');
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

describe('loadEmbedConfigFile', () => {
  it('loads a valid config file', () => {
    const path = writeTempJson({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
      streams: { issues: [{ field: 'description' }] },
    });

    expect(loadEmbedConfigFile(path)).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
      streams: { issues: [{ field: 'description' }] },
    });
  });

  it('rejects a missing file', () => {
    expect(() => loadEmbedConfigFile('/nonexistent/path/embed.json')).toThrow(
      /Unable to read embed config file/
    );
  });

  it('rejects malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'embed-config-'));
    const path = join(dir, 'embed.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(() => loadEmbedConfigFile(path)).toThrow(/not valid JSON/);
  });

  it('rejects a config missing required fields', () => {
    const path = writeTempJson({ provider: 'openai', streams: {} });
    expect(() => loadEmbedConfigFile(path)).toThrow(/Invalid embed config file/);
  });

  it('accepts a host config, which has no model', () => {
    const config = {
      provider: 'host',
      dimension: 1024,
      streams: { issues: [{ field: 'description' }] },
    };
    expect(loadEmbedConfigFile(writeTempJson(config))).toEqual(config);
  });

  it('requires a model for every other provider', () => {
    const path = writeTempJson({
      provider: 'openai',
      streams: { issues: [{ field: 'description' }] },
    });
    expect(() => loadEmbedConfigFile(path)).toThrow(/Invalid embed config file/);
  });

  it('accepts extra top-level fields (shared file with dogsled embed)', () => {
    const path = writeTempJson({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
      streams: { issues: [{ field: 'description' }] },
      api_key: '$OPENAI_API_KEY',
      cost_budget_usd: 5,
    });
    expect(() => loadEmbedConfigFile(path)).not.toThrow();
  });

  it('surfaces Zod issues via CommandError.payload', () => {
    const path = writeTempJson({ provider: 'openai', streams: {} });
    try {
      loadEmbedConfigFile(path);
      throw new Error('expected loadEmbedConfigFile to throw');
    } catch (error) {
      const payload = (error as { payload?: { valid?: boolean; errors?: unknown[] } }).payload;
      expect(payload?.valid).toBe(false);
      expect(Array.isArray(payload?.errors)).toBe(true);
      expect((payload?.errors as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

describe('resolveResourceEmbedConfig', () => {
  const baseConfig = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimension: 1536,
    streams: {
      issues: [{ field: 'description' }],
      comments: [{ field: 'body', as: 'body_vec' as const }],
    },
  };

  it('returns the per-resource config when present', () => {
    expect(resolveResourceEmbedConfig(baseConfig, 'issues')).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
      fields: [{ field: 'description' }],
    });
  });

  it('returns undefined for resources not in the streams map', () => {
    expect(resolveResourceEmbedConfig(baseConfig, 'projects')).toBeUndefined();
  });

  it('preserves the `as` alias when present', () => {
    const resolved = resolveResourceEmbedConfig(baseConfig, 'comments');
    expect(resolved?.fields[0]).toEqual({ field: 'body', as: 'body_vec' });
  });

  it('returns undefined for a host config, whose model is not known here', () => {
    const host = { provider: 'host', dimension: 1024, streams: baseConfig.streams };
    expect(resolveResourceEmbedConfig(host, 'issues')).toBeUndefined();
  });

  it('returns undefined when dimension is unresolved (cannot pre-fill VECTOR)', () => {
    const noDimension = {
      provider: 'openai',
      model: 'unknown-model',
      streams: { issues: [{ field: 'description' }] },
    };
    expect(resolveResourceEmbedConfig(noDimension, 'issues')).toBeUndefined();
  });
});
