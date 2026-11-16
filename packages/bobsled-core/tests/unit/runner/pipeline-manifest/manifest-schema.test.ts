import { describe, expect, it } from 'vitest';

import {
  PipelineManifestValidationError,
  buildPipelineManifestObject,
  parsePipelineManifest,
  safeParsePipelineManifest,
  type PipelineTemplateInput,
} from '../../../../src/manifest.js';

const historicalCommandContract = {
  default_command: 'track',
  command_env: 'TRACK_LANGGRAPH_COMMAND',
  cwd_env: 'TRACK_LANGGRAPH_CWD',
  timeout_seconds_env: 'TRACK_LANGGRAPH_TIMEOUT_SECONDS',
  default_timeout_seconds: 1800,
  output: 'jsonl',
} as const;

const currentCommandContract = {
  default_command: 'track',
  command_env: 'TRACK_PIPELINE_COMMAND',
  cwd_env: 'TRACK_PIPELINE_CWD',
  timeout_seconds_env: 'TRACK_PIPELINE_TIMEOUT_SECONDS',
  default_timeout_seconds: 1800,
  output: 'jsonl',
} as const;

function generatedManifest(warehouse?: string, destinationWarehouse?: string) {
  const extract: PipelineTemplateInput = {
    cron: '0 * * * *',
    graphId: 'bobsled_orders',
    integration: 'stripe',
    ...(warehouse !== undefined ? { warehouse } : {}),
    ...(destinationWarehouse !== undefined ? { destinationWarehouse } : {}),
    modelSequence: [],
    pipelineName: 'orders',
    resources: ['charges'],
    runModels: false,
    schedule: 'hourly',
    trigger: 'schedule',
  };
  return buildPipelineManifestObject([extract], [], 'test');
}

const v1Manifest = {
  kind: 'track.langgraph.dag',
  version: 1,
  track_cli_version: '0.10.0',
  command_contract: historicalCommandContract,
  pipelines: [
    {
      name: 'orders',
      integration: 'stripe',
      graph_id: 'bobsled_orders',
      schedule: { expression: 'hourly', cron: '0 * * * *' },
      state: {
        resource_runs: 'append',
        model_runs: 'append',
        errors: 'append',
      },
      nodes: [
        {
          id: 'extract_0_charges',
          kind: 'track.runner.run_resource',
          pipeline: 'orders',
          integration: 'stripe',
          resource: 'charges',
          command: ['runner', 'run', 'orders', '--resource', 'charges', '--json'],
          emits: ['resource_runs'],
        },
      ],
      edges: [
        { from: '__start__', to: 'extract_0_charges' },
        { from: 'extract_0_charges', to: '__end__' },
      ],
    },
  ],
} as const;

const v2Manifest = {
  kind: 'track.langgraph.dag',
  version: 2,
  track_cli_version: '0.15.0',
  command_contract: historicalCommandContract,
  pipelines: [
    {
      name: 'analytics',
      kind: 'models',
      graph_id: 'bobsled_analytics',
      connection: 'warehouse',
      models: ['stg_orders', 'fct_orders'],
      schedule: { expression: 'daily', cron: '0 6 * * *' },
      state: { model_runs: 'append', errors: 'append' },
      command: ['model', 'run', 'stg_orders', 'fct_orders', '--integration', 'warehouse', '--json'],
    },
  ],
} as const;

const v1ManualManifest = {
  ...v1Manifest,
  pipelines: [
    {
      ...v1Manifest.pipelines[0],
      schedule: { expression: 'manual', cron: 'manual' },
    },
  ],
} as const;

function historicalManifest(warehouse?: string) {
  return JSON.parse(
    JSON.stringify(generatedManifest(warehouse))
      .replaceAll('bobsled.', 'track.')
      .replaceAll('bobsled_cli_version', 'track_cli_version')
      .replaceAll('BOBSLED_CORE_PIPELINE_', 'TRACK_PIPELINE_')
      .replaceAll('"default_command":"bobsled"', '"default_command":"track"')
  );
}

const historicalV3Manifest = {
  ...historicalManifest(),
  kind: 'track.langgraph.dag',
  version: 3,
  command_contract: historicalCommandContract,
} as const;

const historicalV4Manifest = {
  ...historicalManifest(),
  version: 4,
} as const;

const historicalV5Manifest = {
  ...historicalManifest('large'),
  version: 5,
} as const;

describe('persisted pipeline manifest validation', () => {
  it('round-trips generated v7 JSON into a genuinely validated typed manifest', () => {
    const generated = generatedManifest('large');
    const persisted: unknown = JSON.parse(JSON.stringify(generated));

    const parsed = parsePipelineManifest(persisted);

    expect(parsed).toEqual(generated);
    expect(parsed.version).toBe(7);
    expect(parsed.kind).toBe('bobsled.pipeline.dag');
    expect(parsed.command_contract).toEqual({
      ...currentCommandContract,
      default_command: 'bobsled',
      command_env: 'BOBSLED_CORE_PIPELINE_COMMAND',
      cwd_env: 'BOBSLED_CORE_PIPELINE_CWD',
      timeout_seconds_env: 'BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS',
    });
  });

  it.each([
    v1Manifest,
    v2Manifest,
    historicalV3Manifest,
    historicalV4Manifest,
    historicalV5Manifest,
    { ...historicalManifest(), version: 6 },
  ])('rejects retired manifest version $version', (manifest) => {
    const parsed = safeParsePipelineManifest(manifest);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Retired manifest accepted');
    expect(parsed.issues[0]?.code).toBe('unsupported_version');
  });

  it('keeps current warehouse metadata strict', () => {
    const generated = generatedManifest('large');
    const invalid = { ...generated, pipelines: [{ ...generated.pipelines[0], warehouse: 12 }] };
    expect(safeParsePipelineManifest(invalid).success).toBe(false);
    expect(safeParsePipelineManifest(generated).success).toBe(true);
  });

  it('preserves destination warehouse metadata outside nodes', () => {
    const generated = generatedManifest('source-large', 'medium');
    const v5WithDestinationWarehouse = {
      ...generated,
      version: 5,
    };

    expect(safeParsePipelineManifest(v5WithDestinationWarehouse).success).toBe(false);
    expect(parsePipelineManifest(generated).pipelines[0]).toMatchObject({
      kind: 'extract',
      warehouse: 'source-large',
      destination_warehouse: 'medium',
    });
    expect(JSON.stringify(generated.pipelines[0]?.nodes)).not.toContain('destination_warehouse');
  });

  it('persists warehouse metadata for model pipelines without changing node commands', () => {
    const manifest = buildPipelineManifestObject(
      [],
      [
        {
          pipelineName: 'silver_models',
          graphId: 'bobsled_silver_models',
          connection: 'snowflake',
          warehouse: 'large',
          models: ['daily_revenue'],
          modelNodes: [{ name: 'daily_revenue', refs: [] }],
          schedule: 'daily',
          cron: '0 6 * * *',
          trigger: 'schedule',
          synthetic: false,
        },
      ],
      'test'
    );

    expect(manifest.pipelines[0]).toMatchObject({
      kind: 'models',
      warehouse: 'large',
      nodes: [
        expect.objectContaining({
          command: ['model', 'run', 'daily_revenue', '--integration', 'snowflake', '--json'],
        }),
      ],
    });
    expect(parsePipelineManifest(manifest)).toEqual(manifest);
  });

  it('does not reinterpret a manifest when its header and version disagree', () => {
    const v4WithHistoricalHeader: unknown = {
      ...generatedManifest(),
      kind: 'track.langgraph.dag',
      command_contract: historicalCommandContract,
    };
    const v3WithCurrentHeader: unknown = {
      ...historicalV3Manifest,
      kind: 'track.pipeline.dag',
      command_contract: currentCommandContract,
    };

    expect(safeParsePipelineManifest(v4WithHistoricalHeader).success).toBe(false);
    expect(safeParsePipelineManifest(v3WithCurrentHeader).success).toBe(false);
  });

  it('rejects legacy manual pipelines that predate the trigger field', () => {
    expect(safeParsePipelineManifest(v1ManualManifest).success).toBe(false);
  });

  it('bounds top-level load table prefixes', () => {
    const oversized = structuredClone(generatedManifest()) as unknown as {
      pipelines: Array<{ nodes: Array<{ load?: { table_prefix?: string } }> }>;
    };
    oversized.pipelines[0]!.nodes[0]!.load = { table_prefix: 'x'.repeat(4_097) };

    expect(safeParsePipelineManifest(oversized).success).toBe(false);
  });

  it('returns an actionable incompatible-version issue', () => {
    const result = safeParsePipelineManifest({ ...generatedManifest(), version: 99 });

    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: 'unsupported_version',
          path: '$.version',
          message: 'Unsupported manifest version 99. Compatible versions: 7.',
        },
      ],
    });
  });

  it('rejects malformed commands instead of casting persisted JSON', () => {
    const malformed = structuredClone(generatedManifest()) as unknown as {
      pipelines: Array<{ nodes: Array<{ command: unknown }> }>;
    };
    malformed.pipelines[0]!.nodes[0]!.command = ['runner', ''];

    const result = safeParsePipelineManifest(malformed);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'invalid_manifest',
          path: '$.pipelines[0].nodes[0].command[1]',
        })
      );
    }
  });

  it('rejects commands that contradict the declared pipeline task', () => {
    const corrupt = structuredClone(generatedManifest());
    const pipeline = corrupt.pipelines[0]!;
    if (pipeline.kind !== 'extract') throw new Error('expected extract fixture');
    pipeline.nodes[0]!.command = [
      'runner',
      'run',
      'another_pipeline',
      '--resource',
      'customers',
      '--json',
    ];

    const result = safeParsePipelineManifest(corrupt);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'command_contract_mismatch',
          path: '$.pipelines[0].nodes[0].command',
        })
      );
    }
  });

  it('rejects a manual schedule sentinel in either field of a scheduled pipeline', () => {
    const corrupt = structuredClone(generatedManifest());
    corrupt.pipelines[0]!.schedule.cron = 'manual';

    const result = safeParsePipelineManifest(corrupt);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'schedule_trigger_mismatch' })
      );
    }
  });

  it('bounds untrusted command collections before semantic graph traversal', () => {
    const oversized = structuredClone(generatedManifest());
    const pipeline = oversized.pipelines[0]!;
    if (pipeline.kind !== 'extract') throw new Error('expected extract fixture');
    pipeline.nodes[0]!.command = Array.from({ length: 257 }, () => 'token');

    const result = safeParsePipelineManifest(oversized);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'invalid_manifest',
          path: '$.pipelines[0].nodes[0].command',
        })
      );
    }
  });

  it('rejects duplicate ids, unknown endpoints, cycles, and unreachable nodes', () => {
    const corrupt = structuredClone(generatedManifest());
    const pipeline = corrupt.pipelines[0]!;
    if (pipeline.kind !== 'extract') throw new Error('expected extract fixture');
    pipeline.nodes.push({ ...pipeline.nodes[0]! });
    pipeline.edges = [
      { from: '__start__', to: 'missing' },
      { from: pipeline.nodes[0]!.id, to: pipeline.nodes[0]!.id },
    ];

    const result = safeParsePipelineManifest(corrupt);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'duplicate_node_id',
          'invalid_edge_endpoint',
          'cyclic_graph',
          'unreachable_node',
        ])
      );
    }
  });

  it('does not report a cycle solely because an edge has an invalid direction', () => {
    const corrupt = structuredClone(generatedManifest());
    const pipeline = corrupt.pipelines[0]!;
    pipeline.edges.push({ from: pipeline.nodes[0]!.id, to: '__start__' });

    const result = safeParsePipelineManifest(corrupt);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_edge_direction' })
      );
      expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'cyclic_graph' }));
    }
  });

  it('rejects duplicate pipeline and graph identifiers', () => {
    const duplicate = generatedManifest();
    duplicate.pipelines.push(structuredClone(duplicate.pipelines[0]!));

    const result = safeParsePipelineManifest(duplicate);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['duplicate_pipeline_name', 'duplicate_graph_id'])
      );
    }
  });

  it('throws a typed validation error with the same issue list as safeParse', () => {
    const corrupt = { ...generatedManifest(), kind: 'not-track' };
    const safe = safeParsePipelineManifest(corrupt);

    expect(() => parsePipelineManifest(corrupt)).toThrow(PipelineManifestValidationError);
    try {
      parsePipelineManifest(corrupt);
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineManifestValidationError);
      if (error instanceof PipelineManifestValidationError && !safe.success) {
        expect(error.issues).toEqual(safe.issues);
      }
    }
  });
});

describe('pipeline manifest collection limits', () => {
  function extractPipelineAt(index: number) {
    const pipeline = structuredClone(generatedManifest().pipelines[0]!);
    if (pipeline.kind !== 'extract') throw new Error('expected extract fixture');
    pipeline.name = `orders_${index}`;
    pipeline.graph_id = `bobsled_orders_${index}`;
    for (const node of pipeline.nodes) {
      if (node.kind === 'bobsled.runner.run_resource') {
        node.pipeline = pipeline.name;
        node.command = ['runner', 'run', pipeline.name, '--resource', node.resource, '--json'];
      }
    }
    return pipeline;
  }

  it('rejects an oversized pipelines array before validating its elements', () => {
    const manifest = { ...generatedManifest(), pipelines: new Array(1_000_000).fill(0) };
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();

    const result = safeParsePipelineManifest(manifest);

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(256 * 1024 * 1024);
    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: 'invalid_manifest',
          path: '$.pipelines',
          message: 'Too big: expected array to have <=10000 items',
        },
      ],
    });
    expect(() => parsePipelineManifest(manifest)).toThrow(PipelineManifestValidationError);
  });

  it('returns a failure instead of throwing for an 8 MB oversized manifest', () => {
    const manifest = { ...generatedManifest(), pipelines: new Array(4_000_000).fill(0) };
    expect(JSON.stringify(manifest).length).toBeGreaterThan(8_000_000);

    let result: ReturnType<typeof safeParsePipelineManifest> | undefined;
    expect(() => {
      result = safeParsePipelineManifest(manifest);
    }).not.toThrow();
    expect(result?.success).toBe(false);
    if (result && !result.success) expect(result.issues).toHaveLength(1);
  });

  it('rejects oversized nested collections with a single issue', () => {
    const edges = structuredClone(generatedManifest());
    edges.pipelines[0]!.edges = new Array(50_001).fill(0);
    const metadata = structuredClone(generatedManifest()) as unknown as {
      pipelines: Array<{ resource_metadata?: Record<string, unknown> }>;
    };
    metadata.pipelines[0]!.resource_metadata = {
      charges: { input_matrix: { axes: { day: new Array(10_001).fill(0) }, concurrency: 1 } },
    };

    expect(safeParsePipelineManifest(edges)).toEqual({
      success: false,
      issues: [
        {
          code: 'invalid_manifest',
          path: '$.pipelines[0].edges',
          message: 'Too big: expected array to have <=50000 items',
        },
      ],
    });
    expect(safeParsePipelineManifest(metadata)).toEqual({
      success: false,
      issues: [
        {
          code: 'invalid_manifest',
          path: '$.pipelines[0].resource_metadata.charges.input_matrix.axes.day',
          message: 'Too big: expected array to have <=10000 items',
        },
      ],
    });
  });

  it('still accepts manifests exactly at the pipeline, node and edge limits', () => {
    const manyPipelines = {
      ...generatedManifest(),
      pipelines: Array.from({ length: 10_000 }, (_, index) => extractPipelineAt(index)),
    };
    expect(safeParsePipelineManifest(manyPipelines).success).toBe(true);

    const wide = extractPipelineAt(0);
    const template = wide.nodes[0]!;
    if (template.kind !== 'bobsled.runner.run_resource') throw new Error('expected resource node');
    const ids = Array.from({ length: 10_000 }, (_, index) => `extract_${index}`);
    wide.nodes = ids.map((id, index) => ({
      ...template,
      id,
      resource: `resource_${index}`,
      resources: [`resource_${index}`],
      command: ['runner', 'run', wide.name, '--resource', `resource_${index}`, '--json'],
    }));
    const edges = ids.flatMap((id) => [
      { from: '__start__', to: id },
      { from: id, to: '__end__' },
    ]);
    for (let step = 1; edges.length < 50_000; step += 1) {
      for (let index = 0; index + step < ids.length && edges.length < 50_000; index += 1) {
        edges.push({ from: ids[index]!, to: ids[index + step]! });
      }
    }
    wide.edges = edges;
    expect(edges).toHaveLength(50_000);
    expect(safeParsePipelineManifest({ ...generatedManifest(), pipelines: [wide] }).success).toBe(
      true
    );
  });
});
