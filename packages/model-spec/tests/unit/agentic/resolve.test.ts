import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { resolveAgenticModel } from '../../../src/agentic/index.js';

const model = () =>
  parse(
    readFileSync(new URL('../../fixtures/agentic/prepared-pairs.yml', import.meta.url), 'utf8')
  );
const inputs = {
  undecided_pairs: [
    { name: 'pair_id', type: 'string', nullable: false },
    { name: 'left_name', type: 'string', nullable: true },
  ],
};
const platform = {
  models: {
    review: {
      provider: 'openai',
      model: 'test-model',
      api_key: '$TEST_API_KEY',
      auth_env_vars: ['TEST_API_KEY'],
    },
  },
};

describe('agentic schema resolution', () => {
  it('infers input columns and binds the author-selected profile', () => {
    const resolved = resolveAgenticModel(model(), { inputs, platform });
    expect(resolved.steps[0]?.input_columns).toEqual(inputs.undecided_pairs);
    expect(resolved.steps[0]).not.toHaveProperty('input_schemas');
    expect(resolved.steps[0]?.profile).toEqual({
      name: 'review',
      connection: platform.models.review,
    });
    expect(resolved.output_columns.map((column) => column.name)).toEqual([
      'pair_id',
      'assessment',
      '_bobsled_run_id',
      '_bobsled_evidence',
      '_bobsled_confidence',
      '_bobsled_reason',
    ]);
  });

  it('rejects missing profiles and grouping keys before execution', () => {
    expect(() => resolveAgenticModel(model(), { inputs, platform: { models: {} } })).toThrow(
      /platform.models/
    );
    expect(() =>
      resolveAgenticModel(model(), {
        inputs: { undecided_pairs: inputs.undecided_pairs.slice(1) },
        platform,
      })
    ).toThrow(/pair_id/);
  });
});

it('resolves reduce inputs from saved finding schemas and honors a profile override', () => {
  const spec = model();
  spec.plan.steps.push({
    ...spec.plan.steps[0],
    id: 'compare',
    source: { ref: 'assess' },
    map: undefined,
    reduce: { over: 'assess', group_by: ['pair_id'] },
    llm: { profile: 'compare' },
  });
  delete spec.plan.steps[1].map;
  spec.output.from = 'compare';
  const resolved = resolveAgenticModel(spec, {
    inputs,
    platform: {
      models: {
        ...platform.models,
        compare: { ...platform.models.review, model: 'comparison-model' },
      },
    },
  });
  expect(resolved.steps[1]?.input_columns.map((column) => column.name)).toContain(
    '_bobsled_evidence'
  );
  expect(resolved.steps[1]?.profile.connection.model).toBe('comparison-model');
});

it('binds a self-target read to the output schema without an external input entry', () => {
  const spec = model();
  spec.sources.pairs.ref = spec.name;
  expect(resolveAgenticModel(spec, { inputs: {}, platform }).steps[0]?.input_columns).toEqual(
    resolveAgenticModel(spec, { inputs, platform }).output_columns
  );
});

it('rejects literal profile credentials using the shared connection schema', () => {
  expect(() =>
    resolveAgenticModel(model(), {
      inputs,
      platform: { models: { review: { ...platform.models.review, api_key: 'literal-secret' } } },
    })
  ).toThrow(/environment/);
});

it('keeps multi-input reduce schemas distinct and checks every input key', () => {
  const spec = model();
  const first = spec.plan.steps[0];
  spec.plan.steps.push({
    ...first,
    id: 'phone',
    columns: [first.columns[0], { name: 'phone_match', type: 'boolean', nullable: false }],
  });
  spec.plan.steps.push({
    ...first,
    id: 'combine',
    source: { ref: 'assess' },
    reduce: { over: ['assess', 'phone'], group_by: ['pair_id'] },
  });
  delete spec.plan.steps[2].map;
  spec.output.from = 'combine';
  const resolved = resolveAgenticModel(spec, { inputs, platform });
  expect(Object.keys(resolved.steps[2]!.input_schemas!)).toEqual(['assess', 'phone']);
  expect(resolved.steps[2]!.input_schemas!.phone!.map((column) => column.name)).toContain(
    'phone_match'
  );
  expect(resolved.steps[2]!.input_schemas!.assess!.map((column) => column.name)).not.toContain(
    'phone_match'
  );
  spec.plan.steps[1].columns[0] = { name: 'pair_id', type: 'number', nullable: false };
  expect(() => resolveAgenticModel(spec, { inputs, platform })).toThrow(/preserve input key/);
});

it.each([
  ['assess', 'future'],
  ['assess', 'pairs'],
  ['assess', 'assess'],
  ['phone', 'assess'],
])('rejects invalid reduce inputs %j', (...refs) => {
  const spec = model();
  spec.plan.steps.push({
    ...spec.plan.steps[0],
    id: 'combine',
    source: { ref: 'assess' },
    reduce: { over: refs, group_by: ['pair_id'] },
  });
  delete spec.plan.steps[1].map;
  expect(() => resolveAgenticModel(spec, { inputs, platform })).toThrow();
});

it.each(['context_sources', 'sources'] as const)(
  'resolves %s without broadening an empty allowlist',
  (field) => {
    const spec = model();
    spec.sources.context = { ref: 'api.documents' };
    const step = spec.plan.steps[0];
    step.execution.mode = 'agent_loop';
    step[field] = ['context'];
    expect(resolveAgenticModel(spec, { inputs, platform }).steps[0]?.allowed_sources).toEqual([
      'context',
    ]);
    step[field] = [];
    expect(resolveAgenticModel(spec, { inputs, platform }).steps[0]?.allowed_sources).toEqual([]);
    delete step[field];
    expect(resolveAgenticModel(spec, { inputs, platform }).steps[0]?.allowed_sources).toEqual([
      'pairs',
      'context',
    ]);
  }
);

describe('host-declared profile key names', () => {
  const hostPlatform = {
    models: {
      review: { provider: 'openai', model: 'test-model', api_key: '$HOST_MODEL_KEY' },
    },
  };

  it('stays fail-closed without a host declaration', () => {
    expect(() => resolveAgenticModel(model(), { inputs, platform: hostPlatform })).toThrow(
      'Undeclared API key environment variable: HOST_MODEL_KEY'
    );
    expect(() =>
      resolveAgenticModel(model(), {
        inputs,
        platform: hostPlatform,
        declaredSecretNames: ['OTHER_KEY'],
      })
    ).toThrow('Undeclared API key environment variable: HOST_MODEL_KEY');
  });

  it('accepts a declared name without mutating the supplied platform', () => {
    const before = structuredClone(hostPlatform);
    const resolved = resolveAgenticModel(model(), {
      inputs,
      platform: hostPlatform,
      declaredSecretNames: ['HOST_MODEL_KEY'],
    });
    expect(resolved.steps[0]?.profile.connection).toMatchObject({
      api_key: '$HOST_MODEL_KEY',
      auth_env_vars: ['HOST_MODEL_KEY'],
    });
    expect(hostPlatform).toEqual(before);
  });

  it('rejects invalid declaration names', () => {
    expect(() =>
      resolveAgenticModel(model(), {
        inputs,
        platform: hostPlatform,
        declaredSecretNames: ['NOT-A-NAME'],
      })
    ).toThrow('declaredSecretNames must contain valid environment variable names.');
  });
});

describe('host-managed model auth', () => {
  const hostPlatform = {
    models: {
      review: { provider: 'openai', model: 'test-model', api_key: '$AI_GATEWAY_API_KEY' },
      flash: { provider: 'openai', model: 'test-model', api_key: '${{ env.LLM_API_KEY }}' },
    },
  };

  it('accepts undeclared profile keys without changing placeholders or the platform', () => {
    const before = structuredClone(hostPlatform);
    const resolve = (profile: string) => {
      const spec = model();
      spec.llm.profile = profile;
      return resolveAgenticModel(spec, {
        inputs,
        platform: hostPlatform,
        hostManagedModelAuth: true,
      }).steps[0]?.profile.connection;
    };
    expect(resolve('review')).toEqual({
      ...hostPlatform.models.review,
      auth_env_vars: ['AI_GATEWAY_API_KEY'],
    });
    expect(resolve('flash')).toEqual({
      ...hostPlatform.models.flash,
      auth_env_vars: ['LLM_API_KEY'],
    });
    expect(hostPlatform).toEqual(before);
  });

  it('stays fail-closed when the option is omitted or false', () => {
    for (const hostManagedModelAuth of [undefined, false]) {
      expect(() =>
        resolveAgenticModel(model(), { inputs, platform: hostPlatform, hostManagedModelAuth })
      ).toThrow('Undeclared API key environment variable: AI_GATEWAY_API_KEY');
    }
  });
});
