import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import {
  CommandError,
  buildCommandContext,
  loadIntegrationSpecWithWarnings,
  parseGlobalFlags,
  loadResourceSpecWithWarnings,
} from '../../src/commands/common.js';
import { registerTopupCommand } from '../../src/commands/topup.js';
import { resolveExtractIntentPlan } from '../../src/runtime/extract-intents.js';
import { makeResource } from '../helpers/fixtures.js';
import { registerExtractCommand } from '../../src/commands/extract.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { registerValidateCommand } from '../../src/commands/validate.js';
import { SourceSchema } from '../../src/framework/core/source.js';
import { normalizeSpec } from '../../src/schemas/normalize.js';

const source = {
  spec_version: '2',
  type: 'source',
  name: 'api',
  transports: [
    { id: 'api', type: 'http', base_url: 'https://api.example.com', auth: { type: 'none' } },
  ],
  bobsled_connection_ref: 'api-binding',
  bobsled_source_kind: 'bobsled_api',
};
let root: string;
let originalCwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-alias-extractor-'));
  originalCwd = process.cwd();
  fs.mkdirSync(path.join(root, 'integrations'));
  fs.writeFileSync(path.join(root, 'integrations/api.yml'), YAML.stringify(source));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('legacy integration file aliases', () => {
  it('normalizes only source top-level keys before recursive camel-case normalization', () => {
    const result = normalizeSpec(
      { ...source, resource: { bobsled_connection_ref: 'data' } },
      { path: 'integrations/api.yml' }
    );
    expect(result.data).toMatchObject({
      dogsled_connection_ref: 'api-binding',
      dogsled_source_kind: 'bobsled_api',
      resource: { bobsled_connection_ref: 'data' },
    });
    expect(result.data).not.toHaveProperty('bobsled_connection_ref');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(' ')).not.toContain('api-binding');
  });

  it('returns file-path deprecations from integration loads', () => {
    const file = path.join(root, 'integrations/api.yml');
    const loaded = loadIntegrationSpecWithWarnings(file);
    expect(loaded.spec).not.toHaveProperty('bobsled_connection_ref');
    expect(loaded.warnings).toHaveLength(2);
    expect(
      loaded.warnings.every(
        (warning) => warning.includes(file) && warning.includes('DOGSLED_LEGACY_BLUEPRINT_KEY')
      )
    ).toBe(true);
  });

  it('accepts identical duplicates and rejects conflicting values with the file path', () => {
    const file = path.join(root, 'integrations/api.yml');
    fs.writeFileSync(file, YAML.stringify({ ...source, dogsled_connection_ref: 'api-binding' }));
    expect(loadIntegrationSpecWithWarnings(file).warnings).toHaveLength(2);
    fs.writeFileSync(file, YAML.stringify({ ...source, dogsled_connection_ref: 'private-new' }));
    expect(() => loadIntegrationSpecWithWarnings(file)).toThrow(CommandError);
    try {
      loadIntegrationSpecWithWarnings(file);
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 2 });
    }
    expect(() => loadIntegrationSpecWithWarnings(file)).toThrow(
      `LEGACY_KEY_CONFLICT: ${file}: bobsled_connection_ref conflicts with dogsled_connection_ref`
    );
  });

  it('keeps direct strict schema calls safe without accepting an old prefix wildcard', () => {
    expect(SourceSchema.safeParse(source).success).toBe(true);
    const conflict = SourceSchema.safeParse({ ...source, dogsled_source_kind: 'different' });
    expect(conflict.success).toBe(false);
    if (!conflict.success) {
      expect(conflict.error.issues[0]?.message).toBe(
        'LEGACY_KEY_CONFLICT: bobsled_source_kind conflicts with dogsled_source_kind'
      );
    }
    expect(SourceSchema.safeParse({ ...source, bobsled_unrelated: true }).success).toBe(false);
  });

  it('does not normalize legacy-looking keys at resource roots', () => {
    const file = path.join(root, 'resource.yml');
    fs.writeFileSync(file, YAML.stringify({ type: 'resource', bobsled_connection_ref: 'data' }));
    expect(() => loadResourceSpecWithWarnings(file)).toThrow('Unrecognized key');
  });

  it.each(['run', 'topup'])(
    'keeps camelCase warnings separate from deprecations during %s',
    async (command) => {
      fs.writeFileSync(
        path.join(root, 'integrations/api.yml'),
        YAML.stringify({
          ...source,
          auth_env_vars: ['BC3_TEST_MISSING_TOKEN'],
          transports: [
            { id: 'api', type: 'http', baseUrl: 'https://api.example.com', auth: { type: 'none' } },
          ],
        })
      );
      process.chdir(root);
      const warn = vi.spyOn(ControlLogger.prototype, 'warn').mockResolvedValue(undefined);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const program = new Command();
      if (command === 'run') {
        registerExtractCommand(program);
        await program.parseAsync(['run', '--integration', 'api'], { from: 'user' });
      } else {
        registerTopupCommand(program);
        await expect(
          program.parseAsync(['topup', '--integration', 'api', '--resource', 'missing'], {
            from: 'user',
          })
        ).rejects.toThrow('Resource');
      }
      expect(warn).toHaveBeenCalledWith(
        'integration spec api: normalized key: transports[0].baseUrl → base_url'
      );
      const deprecations = warn.mock.calls.filter(([message]) =>
        message.includes('DOGSLED_LEGACY_BLUEPRINT_KEY')
      );
      expect(deprecations).toHaveLength(1);
      expect(deprecations[0]?.[0]).toContain('bobsled_connection_ref');
      expect(deprecations[0]?.[0]).toContain('bobsled_source_kind');
      expect(deprecations[0]?.[0]).not.toContain('api-binding');
      expect(deprecations[0]?.[0]).not.toContain('normalized key:');
    }
  );

  it('surfaces integration deprecations once when a plan reuses the same file', async () => {
    fs.mkdirSync(path.join(root, 'resources/api'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'resources/api/items.yml'),
      YAML.stringify(
        makeResource({
          name: 'items',
          integration: 'api',
          input: { item: { type: 'string', required: true } },
          billing: {
            mode: 'billable',
            ownership: 'third_party',
            unit: 'credit',
            estimation: { model: 'per_input_row', amount: 1, currency: 'provider_credit' },
            authorization: { requires_plan: true },
          },
        })
      )
    );
    fs.writeFileSync(path.join(root, 'inputs.jsonl'), '{"item":"example"}\n');
    const step = {
      integration: 'api',
      resource: 'items',
      seed: 'inputs',
      input: { item: '${{ seed.item }}' },
      limits: { max_input_rows: 1 },
    };
    fs.writeFileSync(
      path.join(root, 'extract-intents.yml'),
      YAML.stringify({
        spec_version: '1',
        type: 'extract-intents',
        plans: {
          sample: {
            description: 'Example plan',
            budget: { max_estimated_credits: 10, on_exceed: 'fail' },
            seeds: { inputs: { format: 'jsonl', path: './inputs.jsonl' } },
            steps: [
              { ...step, id: 'first' },
              { ...step, id: 'second' },
            ],
          },
        },
      })
    );
    process.chdir(root);
    const resolved = await resolveExtractIntentPlan(
      buildCommandContext(parseGlobalFlags({})),
      'sample'
    );
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('DOGSLED_LEGACY_BLUEPRINT_KEY');
    expect(resolved.warnings[0]).toContain(path.join(root, 'integrations/api.yml'));
    expect(resolved.warnings[0]).not.toContain('api-binding');
  });

  it.each(['text', 'json'])(
    'prioritizes validation errors over strict warnings in %s output',
    async (format) => {
      vi.stubEnv('BC3_TEST_MISSING_TOKEN', undefined);
      fs.writeFileSync(
        path.join(root, 'integrations/api.yml'),
        YAML.stringify({
          ...source,
          auth_env_vars: ['BC3_TEST_MISSING_TOKEN'],
          transports: [
            {
              id: 'api',
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'bearer', token: '${{ env.BC3_TEST_MISSING_TOKEN }}' },
            },
          ],
        })
      );
      process.chdir(root);
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(((value: string | Uint8Array) => {
        output += String(value);
        return true;
      }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const program = new Command();
      registerValidateCommand(program);
      const execution = program.parseAsync(
        ['validate', 'api', '--check-env', '--strict', '--format', format],
        { from: 'user' }
      );
      if (format === 'json') {
        await execution;
        expect(JSON.parse(output)).toMatchObject({ errors: 1, warnings: 2 });
        expect(process.exitCode).toBe(1);
      } else {
        await expect(execution).rejects.toMatchObject({
          message: expect.stringContaining('Validation failed: 1 error(s)'),
          exitCode: 1,
        });
      }
    }
  );

  it.each([false, true])('lists validation warnings and honors strict=%s', async (strict) => {
    fs.writeFileSync(
      path.join(root, 'integrations/api.yml'),
      YAML.stringify({
        ...source,
        transports: [
          { id: 'api', type: 'http', baseUrl: 'https://api.example.com', auth: { type: 'none' } },
        ],
      })
    );
    process.chdir(root);
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((value: string | Uint8Array) => {
      output += String(value);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command();
    registerValidateCommand(program);
    await program.parseAsync(
      ['validate', 'api', '--format', 'json', ...(strict ? ['--strict'] : [])],
      { from: 'user' }
    );
    expect(JSON.parse(output)).toMatchObject({
      errors: 0,
      warnings: 3,
      warning_details: expect.arrayContaining([
        expect.objectContaining({
          warning: expect.stringContaining('DOGSLED_LEGACY_BLUEPRINT_KEY'),
        }),
        expect.objectContaining({ warning: 'transports[0].baseUrl → base_url' }),
      ]),
    });
    expect(process.exitCode).toBe(strict ? 2 : undefined);
  });
});
