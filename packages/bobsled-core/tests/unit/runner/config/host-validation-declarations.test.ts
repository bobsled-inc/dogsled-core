import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateProjectManifest } from '../../../../src/manifest.js';
import { runProjectPipeline } from '../../../../src/pipeline/index.js';
import {
  loadProjectPipelineConfig,
  resolveProjectPipelines,
  validateProjectPipelines,
} from '../../../../src/runner/config/project-resolver.js';

const roots: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-host-validation-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const RUNTIME_SETTINGS = `type: pipeline_config
platform:
  models:
    gateway:
      provider: ai-gateway
      model: openai/gpt-5-mini
      api_key: $AI_GATEWAY_API_KEY
    classifier:
      provider: openai
      model: gpt-4.1-mini
      api_key: $AI_GATEWAY_API_KEY
    flash:
      provider: openai
      model: gpt-4.1-mini
      api_key: \${{ env.LLM_API_KEY }}
`;

function modelProject(): string {
  return project({
    'bobsled.yml': 'pipelines: {}\n',
    'settings/runtime.yml': RUNTIME_SETTINGS,
  });
}

function messages(result: Awaited<ReturnType<typeof validateProjectPipelines>>): string[] {
  return result.status === 'invalid' ? result.issues.map((issue) => issue.path) : [];
}

describe('host-declared names for Project validation', () => {
  it('keeps undeclared platform model keys fail-closed by default and ignores process env', async () => {
    vi.stubEnv('LLM_API_KEY', 'ambient-canary');
    const projectRoot = modelProject();
    const result = await validateProjectPipelines({ projectRoot });
    expect(result.status).toBe('invalid');
    expect(messages(result)).toEqual([
      'settings/runtime.yml:platform.models.classifier.api_key',
      'settings/runtime.yml:platform.models.flash.api_key',
    ]);
    expect(result.status === 'invalid' ? result.issues[0]!.message : '').toBe(
      'Undeclared API key environment variable: AI_GATEWAY_API_KEY. Add AI_GATEWAY_API_KEY to auth_env_vars.'
    );
  });

  it('accepts the standard ai-gateway key name without a declaration', async () => {
    const projectRoot = project({
      'bobsled.yml': 'pipelines: {}\n',
      'settings/runtime.yml': RUNTIME_SETTINGS.split('    classifier:')[0]!,
    });
    await expect(validateProjectPipelines({ projectRoot })).resolves.toMatchObject({
      status: 'valid',
    });
  });

  it('accepts names the host declares, without changing placeholders', async () => {
    const projectRoot = modelProject();
    const declaredEnvNames = ['AI_GATEWAY_API_KEY', 'LLM_API_KEY'];
    const result = await validateProjectPipelines({ projectRoot, declaredEnvNames });
    expect(result.status).toBe('valid');
    const models = result.status === 'valid' ? result.project.config.platform?.models : undefined;
    expect(models?.['flash']).toMatchObject({
      api_key: '${{ env.LLM_API_KEY }}',
      auth_env_vars: declaredEnvNames,
    });
    expect(fs.readFileSync(path.join(projectRoot, 'settings/runtime.yml'), 'utf8')).toBe(
      RUNTIME_SETTINGS
    );
    expect(
      loadProjectPipelineConfig({ projectRoot, declaredEnvNames }).config.platform?.models?.[
        'classifier'
      ]
    ).toMatchObject({ auth_env_vars: declaredEnvNames });
    await expect(generateProjectManifest({ projectRoot, declaredEnvNames })).resolves.toBeDefined();
    await expect(generateProjectManifest({ projectRoot })).rejects.toThrow(
      'Undeclared API key environment variable'
    );
  });

  it('authorizes only the declared names', async () => {
    const projectRoot = modelProject();
    const result = await validateProjectPipelines({
      projectRoot,
      declaredEnvNames: ['AI_GATEWAY_API_KEY'],
    });
    expect(messages(result)).toEqual(['settings/runtime.yml:platform.models.flash.api_key']);
    expect(() => loadProjectPipelineConfig({ projectRoot })).toThrow(
      'Undeclared API key environment variable: AI_GATEWAY_API_KEY'
    );
  });

  it('rejects invalid declaration names before reading the Project', async () => {
    const projectRoot = modelProject();
    await expect(
      validateProjectPipelines({ projectRoot, declaredEnvNames: ['NOT-A-NAME'] })
    ).rejects.toThrow('declaredEnvNames must contain valid environment variable names.');
    expect(() => loadProjectPipelineConfig({ projectRoot, declaredEnvNames: ['1BAD'] })).toThrow(
      'declaredEnvNames must contain valid environment variable names.'
    );
  });
});

const EMBEDDING_PIPELINE = `destinations:
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

describe('host-managed model auth', () => {
  const PROFILE_PATHS = [
    'settings/runtime.yml:platform.models.classifier.api_key',
    'settings/runtime.yml:platform.models.flash.api_key',
  ];

  it('validates, loads, resolves and compiles undeclared profile keys without reading values', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'ambient-canary');
    vi.stubEnv('LLM_API_KEY', 'ambient-canary');
    const projectRoot = modelProject();
    const options = { projectRoot, hostManagedModelAuth: true };
    const result = await validateProjectPipelines(options);
    expect(result).toMatchObject({ status: 'valid', warnings: [] });
    const models = result.status === 'valid' ? result.project.config.platform?.models : undefined;
    expect(models).toEqual({
      gateway: {
        provider: 'ai-gateway',
        model: 'openai/gpt-5-mini',
        api_key: '$AI_GATEWAY_API_KEY',
        auth_env_vars: ['AI_GATEWAY_API_KEY'],
      },
      classifier: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        api_key: '$AI_GATEWAY_API_KEY',
        auth_env_vars: ['AI_GATEWAY_API_KEY'],
      },
      flash: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        api_key: '${{ env.LLM_API_KEY }}',
        auth_env_vars: ['LLM_API_KEY'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('ambient-canary');
    expect(loadProjectPipelineConfig(options).config.platform?.models).toEqual(models);
    await expect(resolveProjectPipelines(options)).resolves.toMatchObject({
      config: { platform: { models } },
    });
    const manifest = await generateProjectManifest(options);
    expect(JSON.stringify(manifest)).not.toContain('ambient-canary');
    expect(fs.readFileSync(path.join(projectRoot, 'settings/runtime.yml'), 'utf8')).toBe(
      RUNTIME_SETTINGS
    );
  });

  it('keeps the same Project fail-closed when the option is omitted or false', async () => {
    const projectRoot = modelProject();
    for (const hostManagedModelAuth of [undefined, false]) {
      const options = { projectRoot, hostManagedModelAuth };
      expect(messages(await validateProjectPipelines(options))).toEqual(PROFILE_PATHS);
      expect(() => loadProjectPipelineConfig(options)).toThrow(
        'Undeclared API key environment variable: AI_GATEWAY_API_KEY'
      );
      await expect(resolveProjectPipelines(options)).rejects.toThrow(
        'Undeclared API key environment variable'
      );
      await expect(generateProjectManifest(options)).rejects.toThrow(
        'Undeclared API key environment variable'
      );
    }
  });

  it('still rejects a pipeline embedding that uses an undeclared key', async () => {
    const projectRoot = project({
      'bobsled.yml': EMBEDDING_PIPELINE,
      'settings/runtime.yml': RUNTIME_SETTINGS,
    });
    const options = { projectRoot, hostManagedModelAuth: true };
    const result = await validateProjectPipelines(options);
    expect(messages(result)).toEqual(['bobsled.yml:pipelines.stripe.embed.api_key']);
    expect(result.status === 'invalid' ? result.issues[0]!.message : '').toBe(
      'Undeclared API key environment variable: HOST_EMBED_KEY. Add HOST_EMBED_KEY to auth_env_vars.'
    );
    expect(() => loadProjectPipelineConfig(options)).toThrow(
      'Undeclared API key environment variable: HOST_EMBED_KEY'
    );
    await expect(generateProjectManifest(options)).rejects.toThrow(
      'Undeclared API key environment variable: HOST_EMBED_KEY'
    );
    const spawn = vi.fn();
    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'stripe',
          env: { HOST_EMBED_KEY: 'host-canary' },
          hostManagedModelAuth: true,
        },
        { spawn }
      )
    ).rejects.toThrow('Undeclared API key environment variable: HOST_EMBED_KEY');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('lets the pipeline SDK resolve undeclared profile keys only with the option', async () => {
    const projectRoot = project({
      'bobsled.yml': EMBEDDING_PIPELINE.replace(/    embed:[\s\S]*$/u, ''),
      'settings/runtime.yml': RUNTIME_SETTINGS,
    });
    const resolved: unknown[] = [];
    const spawn = vi.fn();
    const run = (hostManagedModelAuth?: boolean) =>
      runProjectPipeline(
        { projectRoot, pipelineName: 'stripe', hostManagedModelAuth },
        {
          spawn,
          resolvePipeline: async (input, resolveDefault) => {
            resolved.push(await resolveDefault(input));
            throw new Error('stop before spawning');
          },
        }
      );
    await expect(run()).rejects.toThrow('Undeclared API key environment variable');
    await expect(run(false)).rejects.toThrow('Undeclared API key environment variable');
    expect(resolved).toEqual([]);
    await expect(run(true)).rejects.toThrow('stop before spawning');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      config: {
        platform: {
          models: { flash: { api_key: '${{ env.LLM_API_KEY }}', auth_env_vars: ['LLM_API_KEY'] } },
        },
      },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('integration and action declaration warnings', () => {
  const files = {
    'bobsled.yml': 'pipelines: {}\n',
    'integrations/custom.yml': `spec_version: '1'
type: integration
name: custom
transport:
  type: http
  base_url: https://api.example.com
  auth:
    type: api-key
    header: X-Api-Key
    key: \${{ env.CUSTOM_KEY }}
`,
    'actions/notify.yml': `type: action
name: notify
auth_env_vars: [HOOK_TOKEN]
headers:
  Authorization: Bearer \${{ secrets.HOOK_TOKEN }}
  X-Extra: \${{ secrets.EXTRA_TOKEN }}
`,
  };

  it('reports undeclared credential references as warnings, not errors', async () => {
    const result = await validateProjectPipelines({ projectRoot: project(files) });
    expect(result.status).toBe('valid');
    expect(result.warnings).toEqual([
      'integrations/custom.yml: Integration "custom" references undeclared environment variable CUSTOM_KEY. Add it to auth_env_vars; requests that use an undeclared name are rejected.',
      'actions/notify.yml: Action "notify" references undeclared environment variable EXTRA_TOKEN. Add it to auth_env_vars; requests that use an undeclared name are rejected.',
    ]);
  });

  it('omits warnings for names the host declares', async () => {
    const result = await validateProjectPipelines({
      projectRoot: project(files),
      declaredEnvNames: ['CUSTOM_KEY', 'EXTRA_TOKEN'],
    });
    expect(result.status).toBe('valid');
    expect(result.warnings).toEqual([]);
  });
});
