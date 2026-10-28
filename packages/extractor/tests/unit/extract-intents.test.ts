import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCommandContext, parseGlobalFlags } from '../../src/commands/common.js';
import { loadSeedRows, resolveExtractIntentPlan } from '../../src/runtime/extract-intents.js';

import { makeProvider, makeResource } from '../helpers/fixtures.js';

describe('extract intents runtime', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-intents-'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads csv, jsonl, and yaml seeds', async () => {
    fs.mkdirSync(path.join(tmpDir, 'seeds'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'seeds', 'candidates.csv'),
      'first_name,last_name\nAda,Lovelace\nGrace,Hopper\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'seeds', 'candidates.jsonl'),
      ['{"profile":"https://example.com/ada"}', '{"profile":"https://example.com/grace"}'].join(
        '\n'
      ),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'seeds', 'candidates.yml'),
      YAML.stringify([{ domain: 'example.com' }, { domain: 'openai.com' }]),
      'utf-8'
    );

    const csvSeed = await loadSeedRows(tmpDir, {
      format: 'csv',
      path: './seeds/candidates.csv',
    });
    const jsonlSeed = await loadSeedRows(tmpDir, {
      format: 'jsonl',
      path: './seeds/candidates.jsonl',
    });
    const yamlSeed = await loadSeedRows(tmpDir, {
      format: 'yaml',
      path: './seeds/candidates.yml',
    });

    expect(csvSeed.fields).toEqual(['first_name', 'last_name']);
    expect(csvSeed.rows).toHaveLength(2);
    expect(jsonlSeed.fields).toEqual(['profile']);
    expect(jsonlSeed.rows).toHaveLength(2);
    expect(yamlSeed.fields).toEqual(['domain']);
    expect(yamlSeed.rows).toHaveLength(2);
  });

  it('resolves plan estimates and rejects missing seed bindings', async () => {
    writeProjectFiles(tmpDir, {
      plan: {
        spec_version: '1',
        type: 'extract-intents',
        plans: {
          enrich_targets: {
            description: 'Enrich targets',
            budget: {
              max_estimated_credits: 20,
              on_exceed: 'fail',
            },
            seeds: {
              candidates: {
                format: 'csv',
                path: './seeds/candidates.csv',
              },
            },
            steps: [
              {
                id: 'person_enrich',
                integration: 'test_api',
                resource: 'person_enrich',
                seed: 'candidates',
                input: {
                  profile: '${{ seed.linkedin_url }}',
                },
                limits: {
                  max_input_rows: 1,
                },
              },
            ],
          },
          broken_targets: {
            description: 'Broken targets',
            budget: {
              max_estimated_credits: 20,
              on_exceed: 'fail',
            },
            seeds: {
              candidates: {
                format: 'csv',
                path: './seeds/candidates.csv',
              },
            },
            steps: [
              {
                id: 'broken_enrich',
                integration: 'test_api',
                resource: 'person_enrich',
                seed: 'candidates',
                input: {
                  profile: '${{ seed.missing_profile }}',
                },
                limits: {
                  max_input_rows: 1,
                },
              },
            ],
          },
        },
      },
    });

    process.chdir(tmpDir);
    const ctx = buildCommandContext(parseGlobalFlags({}));
    const resolved = await resolveExtractIntentPlan(ctx, 'enrich_targets');

    expect(resolved.total_estimated_credits).toBe(1);
    expect(resolved.total_estimated_requests).toBe(1);
    expect(resolved.estimate_confidence).toBe('exact');
    expect(resolved.steps[0]?.inputs[0]?.input).toEqual({
      profile: 'https://linkedin.example/ada',
    });

    await expect(resolveExtractIntentPlan(ctx, 'broken_targets')).rejects.toThrow(
      'references seed field "missing_profile"'
    );
  });

  it('rejects a step referencing an unknown seed name', async () => {
    writeProjectFiles(tmpDir, {
      plan: {
        spec_version: '1',
        type: 'extract-intents',
        plans: {
          typo_plan: {
            description: 'Plan with typo in seed name',
            budget: {
              max_estimated_credits: 20,
              on_exceed: 'fail',
            },
            seeds: {
              candidates: {
                format: 'csv',
                path: './seeds/candidates.csv',
              },
            },
            steps: [
              {
                id: 'person_enrich',
                integration: 'test_api',
                resource: 'person_enrich',
                seed: 'typo_seed',
                input: {
                  profile: '${{ seed.linkedin_url }}',
                },
                limits: {
                  max_input_rows: 1,
                },
              },
            ],
          },
        },
      },
    });

    process.chdir(tmpDir);
    const ctx = buildCommandContext(parseGlobalFlags({}));

    await expect(resolveExtractIntentPlan(ctx, 'typo_plan')).rejects.toThrow(
      /unknown seed "typo_seed"/
    );
  });

  it('marks per-match billing estimates as upper bounds', async () => {
    writeProjectFiles(tmpDir, {
      resource: makeBillableResource({
        billing: {
          mode: 'billable',
          ownership: 'third_party',
          unit: 'match',
          estimation: {
            model: 'per_match',
            amount: 2,
            currency: 'provider_credit',
          },
          authorization: {
            requires_plan: true,
          },
        },
      }),
      plan: {
        spec_version: '1',
        type: 'extract-intents',
        plans: {
          enrich_targets: {
            description: 'Enrich targets',
            budget: {
              max_estimated_credits: 20,
              on_exceed: 'fail',
            },
            seeds: {
              candidates: {
                format: 'csv',
                path: './seeds/candidates.csv',
              },
            },
            steps: [
              {
                id: 'person_enrich',
                integration: 'test_api',
                resource: 'person_enrich',
                seed: 'candidates',
                input: {
                  profile: '${{ seed.linkedin_url }}',
                },
                limits: {
                  max_input_rows: 2,
                },
              },
            ],
          },
        },
      },
    });

    process.chdir(tmpDir);
    const ctx = buildCommandContext(parseGlobalFlags({}));
    const resolved = await resolveExtractIntentPlan(ctx, 'enrich_targets');

    expect(resolved.total_estimated_credits).toBe(4);
    expect(resolved.estimate_confidence).toBe('upper_bound');
  });

  it('rejects a lookup-only Resource in an extraction plan', async () => {
    writeProjectFiles(tmpDir, {
      resource: {
        type: 'resource',
        name: 'person_enrich',
        description: 'Find one person',
        output: { id: { type: 'string', path: '$.id' } },
        lookup: {
          description: 'Find one person',
          api: { endpoint: '/people/${{ input.profile }}', method: 'GET' },
          input: { profile: { type: 'string', required: true } },
        },
      },
      plan: {
        spec_version: '1',
        type: 'extract-intents',
        plans: {
          enrich_targets: {
            description: 'Enrich targets',
            budget: { max_estimated_credits: 20, on_exceed: 'fail' },
            seeds: {
              candidates: { format: 'csv', path: './seeds/candidates.csv' },
            },
            steps: [
              {
                id: 'person_enrich',
                integration: 'test_api',
                resource: 'person_enrich',
                seed: 'candidates',
                input: { profile: '${{ seed.linkedin_url }}' },
                limits: { max_input_rows: 1 },
              },
            ],
          },
        },
      },
    });

    process.chdir(tmpDir);
    const ctx = buildCommandContext(parseGlobalFlags({}));

    await expect(resolveExtractIntentPlan(ctx, 'enrich_targets')).rejects.toThrow(
      'Resource only supports lookup'
    );
  });
});

function writeProjectFiles(
  projectDir: string,
  overrides: {
    resource?: Record<string, unknown>;
    plan: Record<string, unknown>;
  }
): void {
  fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'resources', 'test_api'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'seeds'), { recursive: true });

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
    YAML.stringify(makeProvider('https://api.example.com', { name: 'test_api' })),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(projectDir, 'resources', 'test_api', 'person_enrich.yml'),
    YAML.stringify(overrides.resource ?? makeBillableResource()),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(projectDir, 'extract-intents.yml'),
    YAML.stringify(overrides.plan),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(projectDir, 'seeds', 'candidates.csv'),
    'linkedin_url\nhttps://linkedin.example/ada\nhttps://linkedin.example/grace\n',
    'utf-8'
  );
}

function makeBillableResource(
  overrides: Partial<ReturnType<typeof makeResource>> = {}
): ReturnType<typeof makeResource> {
  return makeResource({
    name: 'person_enrich',
    integration: 'test_api',
    api: {
      endpoint: '/person/enrich',
      method: 'POST',
      request_body: {
        profile: '${{ input.profile }}',
      },
    },
    input: {
      profile: { type: 'string', required: true },
    },
    output: {
      id: { type: 'string', path: '$.id' },
      profile: { type: 'string', path: '$.profile' },
    },
    extract: {
      record_path: '$',
      table: {
        primary_key: ['id'],
      },
    },
    billing: {
      mode: 'billable',
      ownership: 'third_party',
      unit: 'credit',
      estimation: {
        model: 'per_input_row',
        amount: 1,
        currency: 'provider_credit',
      },
      authorization: {
        requires_plan: true,
      },
    },
    ...overrides,
  });
}
