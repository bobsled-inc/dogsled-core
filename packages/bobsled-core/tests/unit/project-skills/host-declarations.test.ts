import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildProjectSkillReferenceCatalog,
  buildProjectSkillsManifest,
  getProjectSkill,
  loadProjectSkills,
  validateProjectSkills,
  type ProjectSkillsOptions,
} from '../../../src/project-skills/index.js';
import {
  loadProjectPipelineConfig,
  resolveProjectPipelines,
  validateProjectPipelines,
} from '../../../src/runner/config/project-resolver.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PROFILES = [
  ['typesafe', 'AI_GATEWAY_API_KEY'],
  ['google', 'AI_GATEWAY_API_KEY'],
  ['ai-gateway', 'AI_GATEWAY_API_KEY'],
  ['typesafe', 'AI_GATEWAY_API_KEY'],
  ['typesafe', 'LLM_API_KEY'],
  ['google', 'AI_GATEWAY_API_KEY'],
] as const;

const RUNTIME_SETTINGS = `type: pipeline_config
platform:
  models:
${PROFILES.map(
  ([provider, key], index) => `    profile${index + 1}:
      provider: ${provider}
      model: ${provider === 'ai-gateway' ? 'synthetic/model' : 'synthetic-model'}
      api_key: $${key}
`
).join('')}`;

const MODEL = `spec_version: '0.2'
type: model
name: synthetic_model
source:
  ref: duckdb.raw_synthetic
`;

function embeddingPipeline(embed: string): string {
  return `type: pipeline_config
destinations:
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
${embed}`;
}

const UNDECLARED_EMBEDDING = embeddingPipeline(`      provider: openai
      model: text-embedding-3-small
      api_key: $HOST_EMBED_KEY
      streams:
        charges: [{ field: description }]
`);

const PROFILE_KEY_ERROR = /^Undeclared API key environment variable: /u;
const EMBED_KEY_ERROR =
  'Undeclared API key environment variable: HOST_EMBED_KEY. Add HOST_EMBED_KEY to auth_env_vars.';

function skill(references: readonly (readonly [string, string])[]): string {
  const block = references.map(([kind, name]) => `  - kind: ${kind}\n    name: ${name}\n`);
  return `---
name: synthetic
description: Synthetic reference validation probe.
${block.length ? `references:\n${block.join('')}` : ''}---

Synthetic skill body.
`;
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-skill-host-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

/** The two-file reproduction: runtime model profiles plus one Skill that references a model. */
function profileProject(references = true): string {
  return project({
    'settings/runtime.yml': RUNTIME_SETTINGS,
    'skills/synthetic/SKILL.md': skill(references ? [['model', 'synthetic_model']] : []),
    'models/synthetic_model.yml': MODEL,
  });
}

function embeddingProject(pipelines = UNDECLARED_EMBEDDING): string {
  return project({
    'settings/pipelines.yml': pipelines,
    'skills/synthetic/SKILL.md': skill([
      ['model', 'synthetic_model'],
      ['pipeline', 'stripe'],
    ]),
    'models/synthetic_model.yml': MODEL,
  });
}

async function issueMessages(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
    return [];
  } catch (error) {
    const issues = (error as { issues?: { message?: unknown }[] }).issues ?? [];
    return issues.map((issue) => (typeof issue.message === 'string' ? issue.message : ''));
  }
}

const ENTRY_POINTS: [string, (root: string, options: ProjectSkillsOptions) => Promise<unknown>][] =
  [
    ['loadProjectSkills', (root, options) => loadProjectSkills(root, options)],
    ['getProjectSkill', (root, options) => getProjectSkill(root, 'synthetic', options)],
    ['validateProjectSkills', (root, options) => validateProjectSkills(root, options)],
    [
      'buildProjectSkillsManifest',
      (root, options) => buildProjectSkillsManifest(root, { ...options, guide: false }),
    ],
  ];

const COMPATIBILITY_OPTIONS: ProjectSkillsOptions[] = [
  {},
  { hostManagedModelAuth: false, declaredEnvNames: [] },
  { hostManagedModelAuth: true },
  { declaredEnvNames: ['AI_GATEWAY_API_KEY', 'LLM_API_KEY', 'HOST_EMBED_KEY'] },
  { declaredEnvNames: ['NOT-A-NAME'] },
];

describe('Project Skill references without credential declarations', () => {
  it('loads the model profile reproduction without host options', async () => {
    const root = profileProject();
    const catalog = await buildProjectSkillReferenceCatalog(root);
    expect(catalog.resolve('model', 'synthetic_model')).toEqual({
      status: 'found',
      canonicalName: 'synthetic_model',
    });
    for (const [, run] of ENTRY_POINTS) {
      await expect(run(root, {})).resolves.toBeTruthy();
    }
    const registry = await loadProjectSkills(root);
    expect(registry.skills.map((entry) => entry.name)).toEqual(['synthetic']);
  });

  it('keeps model profile keys enforced by Project validation', async () => {
    const root = profileProject();
    const result = await validateProjectPipelines({ projectRoot: root });
    expect(result.status).toBe('invalid');
    expect(result.issues.filter((issue) => PROFILE_KEY_ERROR.test(issue.message))).toHaveLength(5);
    expect(
      (await issueMessages(async () => loadProjectPipelineConfig({ projectRoot: root }))).filter(
        (message) => PROFILE_KEY_ERROR.test(message)
      )
    ).toHaveLength(5);
  });

  it('loads Skills whose project has an undeclared embedding key', async () => {
    const root = embeddingProject();
    const catalog = await buildProjectSkillReferenceCatalog(root);
    expect(catalog.names.pipeline).toEqual(['stripe']);
    expect(catalog.names.model).toEqual(['synthetic_model']);
    for (const [, run] of ENTRY_POINTS) {
      await expect(run(root, {})).resolves.toBeTruthy();
    }
  });

  it('keeps an undeclared embedding key failing Project validation and loading', async () => {
    const root = embeddingProject();
    const result = await validateProjectPipelines({ projectRoot: root });
    expect(result.status).toBe('invalid');
    expect(result.issues.map((issue) => issue.message)).toEqual([EMBED_KEY_ERROR]);
    expect(await issueMessages(() => resolveProjectPipelines({ projectRoot: root }))).toEqual([
      EMBED_KEY_ERROR,
    ]);
    expect(
      await issueMessages(async () =>
        loadProjectPipelineConfig({ projectRoot: root, hostManagedModelAuth: true })
      )
    ).toEqual([EMBED_KEY_ERROR]);
    await expect(
      validateProjectPipelines({ projectRoot: root, declaredEnvNames: ['HOST_EMBED_KEY'] })
    ).resolves.toMatchObject({ status: 'valid' });
  });

  it('accepts the host options for compatibility without changing the names', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'ambient-canary');
    for (const root of [profileProject(), embeddingProject()]) {
      const expected = (await buildProjectSkillReferenceCatalog(root)).names;
      for (const options of COMPATIBILITY_OPTIONS) {
        const catalog = await buildProjectSkillReferenceCatalog(root, undefined, options);
        expect(catalog.names).toEqual(expected);
        for (const [, run] of ENTRY_POINTS) {
          await expect(run(root, options)).resolves.toBeTruthy();
        }
      }
    }
  });

  it.each([
    [
      'an unknown pipeline type',
      `type: pipeline_config
pipelines:
  stripe:
    type: managed
`,
      /Unknown pipeline type "managed"/u,
    ],
    [
      'an embedding without streams',
      embeddingPipeline(`      provider: openai
      model: text-embedding-3-small
      api_key: $HOST_EMBED_KEY
`),
      /pipelines\.stripe\.embed\.streams/u,
    ],
    [
      'an embedding key that is not a placeholder',
      embeddingPipeline(`      provider: openai
      model: text-embedding-3-small
      api_key: literal-value
      streams:
        charges: [{ field: description }]
`),
      /pipelines\.stripe\.embed\.api_key: Must be an environment variable placeholder/u,
    ],
    [
      'an Ollama embedding over plain HTTP off loopback',
      embeddingPipeline(`      provider: ollama
      model: nomic-embed-text
      base_url: http://203.0.113.10:11434/api
      streams:
        charges: [{ field: description }]
`),
      /Ollama base_url must use HTTPS or HTTP on loopback/u,
    ],
    [
      'an unknown model profile field',
      `type: pipeline_config
platform:
  models:
    default:
      provider: openai
      model: synthetic-model
      api_key: $OPENAI_API_KEY
      unexpected: true
`,
      /unexpected|Unrecognized/u,
    ],
    ['invalid YAML', 'type: pipeline_config\npipelines: [unclosed\n', /Invalid YAML/u],
  ])('still rejects %s in the Skills catalog', async (_label, config, message) => {
    const root = embeddingProject(config);
    const error = await buildProjectSkillReferenceCatalog(root).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toMatch(/Undeclared/u);
    await expect(loadProjectSkills(root)).rejects.toThrow(message);
  });

  it('keeps Skills without references independent of the pipeline config', async () => {
    const root = profileProject(false);
    await expect(loadProjectSkills(root)).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: 'synthetic' })],
    });
  });
});
