import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDogsledConfig } from '../../src/manifest.js';
import { parseReverseEtlProject } from '../../src/reverse-etl/index.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PLATFORM = `platform:
  models:
    classifier:
      provider: openai
      model: gpt-4.1-mini
      api_key: $AI_GATEWAY_API_KEY
    flash:
      provider: openai
      model: gpt-4.1-mini
      api_key: \${{ env.LLM_API_KEY }}
`;

const EMBEDDING = `destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  stripe:
    schedule: daily
    source: stripe
    destination: warehouse
    resources: [charges]
    embed:
      provider: openai
      model: text-embedding-3-small
      api_key: $HOST_EMBED_KEY
      streams:
        charges: [{ field: description }]
`;

const PROFILE_ERRORS = [
  'Undeclared API key environment variable: AI_GATEWAY_API_KEY',
  'Undeclared API key environment variable: LLM_API_KEY',
];
const EMBED_ERROR = 'Undeclared API key environment variable: HOST_EMBED_KEY';

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-host-call-sites-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

function configErrors(result: ReturnType<typeof parseReverseEtlProject>): string[] {
  return result.errors
    .filter((error) => error.kind === 'dogsled-config')
    .map((error) => error.message);
}

describe('parseReverseEtlProject host declarations', () => {
  it('keeps undeclared profile keys fail-closed by default', () => {
    vi.stubEnv('LLM_API_KEY', 'ambient-canary');
    const root = project({ 'settings/runtime.yml': `type: pipeline_config\n${PLATFORM}` });
    const errors = configErrors(parseReverseEtlProject(root));
    for (const message of PROFILE_ERRORS) {
      expect(errors.some((error) => error.includes(message))).toBe(true);
    }
    expect(configErrors(parseReverseEtlProject(root, undefined, {}))).toEqual(errors);
    expect(
      configErrors(parseReverseEtlProject(root, undefined, { hostManagedModelAuth: false }))
    ).toEqual(errors);
  });

  it('forwards hostManagedModelAuth and declaredEnvNames to the pipeline config check', () => {
    const root = project({ 'settings/runtime.yml': `type: pipeline_config\n${PLATFORM}` });
    expect(parseReverseEtlProject(root, undefined, { hostManagedModelAuth: true }).errors).toEqual(
      []
    );
    expect(
      parseReverseEtlProject(root, undefined, {
        declaredEnvNames: ['AI_GATEWAY_API_KEY', 'LLM_API_KEY'],
      }).errors
    ).toEqual([]);
  });

  it('accepts an embedding key only through declaredEnvNames', () => {
    const root = project({ 'settings/pipelines.yml': `type: pipeline_config\n${EMBEDDING}` });
    const managed = configErrors(
      parseReverseEtlProject(root, undefined, { hostManagedModelAuth: true })
    );
    expect(managed.some((error) => error.includes(EMBED_ERROR))).toBe(true);
    expect(
      parseReverseEtlProject(root, undefined, { declaredEnvNames: ['HOST_EMBED_KEY'] }).errors
    ).toEqual([]);
  });
});

describe('loadDogsledConfig host declarations', () => {
  it('keeps undeclared profile keys fail-closed by default', () => {
    vi.stubEnv('LLM_API_KEY', 'ambient-canary');
    const root = project({ 'dogsled.yml': `pipelines: {}\n${PLATFORM}` });
    const configPath = path.join(root, 'dogsled.yml');
    for (const options of [undefined, {}, { hostManagedModelAuth: false }]) {
      expect(() => loadDogsledConfig(configPath, options)).toThrow(PROFILE_ERRORS[0]);
      expect(() => loadDogsledConfig(configPath, options)).toThrow(PROFILE_ERRORS[1]);
    }
  });

  it('forwards hostManagedModelAuth and declaredEnvNames without changing placeholders', () => {
    const root = project({ 'dogsled.yml': `pipelines: {}\n${PLATFORM}` });
    const configPath = path.join(root, 'dogsled.yml');
    const before = readFileSync(configPath, 'utf8');
    const managed = loadDogsledConfig(configPath, { hostManagedModelAuth: true });
    expect(managed.platform?.models?.['flash']?.api_key).toBe('${{ env.LLM_API_KEY }}');
    expect(
      loadDogsledConfig(configPath, { declaredEnvNames: ['AI_GATEWAY_API_KEY', 'LLM_API_KEY'] })
        .platform?.models?.['classifier']?.api_key
    ).toBe('$AI_GATEWAY_API_KEY');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(() => loadDogsledConfig(configPath, { declaredEnvNames: ['NOT-A-NAME'] })).toThrow(
      'declaredEnvNames must contain valid environment variable names.'
    );
  });

  it('accepts an embedding key only through declaredEnvNames', () => {
    const root = project({ 'dogsled.yml': EMBEDDING });
    const configPath = path.join(root, 'dogsled.yml');
    expect(() => loadDogsledConfig(configPath, { hostManagedModelAuth: true })).toThrow(
      EMBED_ERROR
    );
    expect(
      Object.keys(loadDogsledConfig(configPath, { declaredEnvNames: ['HOST_EMBED_KEY'] }).pipelines)
    ).toEqual(['stripe']);
  });
});
