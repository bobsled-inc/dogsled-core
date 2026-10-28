import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  computeSyntheticModelPipelines,
  expandAuthoredModelPipelines,
  resolveModelPipelines,
  resolvePipelines,
  type DiscoveredModel,
} from '../../../src/runner/config/loader.js';
import {
  isManualSchedule,
  MANUAL_SCHEDULE,
  pipelineTrigger,
  pipelineTriggerFor,
  DogsledConfigSchema,
} from '../../../src/runner/config/schema.js';

import { isValidSchedule, parseToCron } from '../../../src/runner/schedule/parser.js';

const bigqueryDestination = {
  type: 'bigquery' as const,
  project: 'my-project',
  dataset: 'raw',
};

type DogsledConfigInput = z.input<typeof DogsledConfigSchema>;

function configWith(
  pipelines: DogsledConfigInput['pipelines'],
  extras: Omit<DogsledConfigInput, 'destinations' | 'pipelines'> = {}
) {
  return DogsledConfigSchema.parse({
    destinations: { warehouse: bigqueryDestination },
    pipelines,
    ...extras,
  });
}

describe('manual schedule sentinel — helpers', () => {
  it('isManualSchedule is case- and whitespace-insensitive', () => {
    expect(isManualSchedule('manual')).toBe(true);
    expect(isManualSchedule('MANUAL')).toBe(true);
    expect(isManualSchedule('  Manual  ')).toBe(true);
    expect(isManualSchedule('hourly')).toBe(false);
    expect(isManualSchedule(undefined)).toBe(false);
  });

  it('pipelineTriggerFor maps schedule strings to trigger kinds', () => {
    expect(pipelineTriggerFor('manual')).toBe('manual');
    expect(pipelineTriggerFor('Manual')).toBe('manual');
    expect(pipelineTriggerFor('hourly')).toBe('schedule');
    expect(pipelineTriggerFor('every 4h')).toBe('schedule');
  });

  it('parseToCron rejects the manual sentinel with a fix-it message', () => {
    expect(() => parseToCron('manual')).toThrow(/branch on isManualSchedule/);
  });

  it('isValidSchedule treats manual as a valid schedule value', () => {
    expect(isValidSchedule('manual')).toBe(true);
    expect(isValidSchedule('hourly')).toBe(true);
    expect(isValidSchedule('not a real schedule')).toBe(false);
  });

  it('MANUAL_SCHEDULE constant matches the parser sentinel', () => {
    expect(MANUAL_SCHEDULE).toBe('manual');
  });
});

describe('DogsledConfigSchema — schedule: manual', () => {
  it('accepts schedule: manual on extract pipelines', () => {
    const config = configWith({
      stripe: {
        schedule: 'manual',
        source: 'stripe',
        destination: 'warehouse',
        resources: ['charges'],
      },
    });
    const entry = config.pipelines['stripe'];
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe('manual');
    expect(pipelineTrigger(entry!)).toBe('manual');
  });

  it('accepts schedule: manual on type: models pipelines', () => {
    const config = configWith({
      bigquery_silver: {
        type: 'models',
        connection: 'bigquery',
        schedule: 'manual',
        models: ['stg_orders'],
      },
    });
    const entry = config.pipelines['bigquery_silver'];
    expect(entry).toBeDefined();
    expect(pipelineTrigger(entry!)).toBe('manual');
  });

  it('accepts defaults.models.schedule: manual', () => {
    const config = configWith({}, { defaults: { models: { schedule: 'manual' } } });
    expect(config.defaults?.models?.schedule).toBe('manual');
  });

  it('still rejects an empty schedule string', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { warehouse: bigqueryDestination },
      pipelines: {
        stripe: {
          schedule: '',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only schedule string', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { warehouse: bigqueryDestination },
      pipelines: {
        stripe: {
          schedule: '   ',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only defaults.models.schedule', () => {
    const result = DogsledConfigSchema.safeParse({
      destinations: { warehouse: bigqueryDestination },
      pipelines: {},
      defaults: { models: { schedule: '   ' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('loader — resolvePipelines / resolveModelPipelines on manual schedules', () => {
  it('resolvePipelines emits cron=null and trigger=manual for extract pipelines with schedule: manual', () => {
    const config = configWith({
      stripe: {
        schedule: 'manual',
        source: 'stripe',
        destination: 'warehouse',
        resources: ['charges'],
      },
    });
    const [resolved] = resolvePipelines(config);
    expect(resolved).toBeDefined();
    expect(resolved!.cron).toBeNull();
    expect(resolved!.trigger).toBe('manual');
    expect(resolved!.schedule).toBe('manual');
  });

  it('resolvePipelines keeps cron + trigger=schedule for scheduled pipelines', () => {
    const config = configWith({
      stripe: {
        schedule: 'hourly',
        source: 'stripe',
        destination: 'warehouse',
        resources: ['charges'],
      },
    });
    const [resolved] = resolvePipelines(config);
    expect(resolved!.cron).toBe('0 * * * *');
    expect(resolved!.trigger).toBe('schedule');
  });

  it('resolveModelPipelines emits cron=null and trigger=manual for model pipelines', () => {
    const config = configWith({
      bigquery_silver: {
        type: 'models',
        connection: 'bigquery',
        schedule: 'manual',
        models: ['stg_orders'],
      },
    });
    const [resolved] = resolveModelPipelines(config);
    expect(resolved).toBeDefined();
    expect(resolved!.cron).toBeNull();
    expect(resolved!.trigger).toBe('manual');
  });
});

describe('synthetic model pipelines — defaults.models.schedule: manual', () => {
  it('propagates manual to every synthetic pipeline', () => {
    const config = configWith({}, { defaults: { models: { schedule: 'manual' } } });
    const models = new Map<string, DiscoveredModel>([
      ['bq_orphan', { connection: 'bigquery', materialization: 'incremental' }],
      ['sf_orphan', { connection: 'snowflake', materialization: 'table' }],
    ]);
    const authored = expandAuthoredModelPipelines(resolveModelPipelines(config), models);
    const synthetic = computeSyntheticModelPipelines(config, authored, models);
    expect(synthetic).toHaveLength(2);
    for (const pipeline of synthetic) {
      expect(pipeline.trigger).toBe('manual');
      expect(pipeline.cron).toBeNull();
      expect(pipeline.schedule).toBe('manual');
    }
  });

  it('keeps cron-derived synthetics when defaults schedule is a real cadence', () => {
    const config = configWith({}, { defaults: { models: { schedule: 'daily' } } });
    const models = new Map<string, DiscoveredModel>([
      ['bq_orphan', { connection: 'bigquery', materialization: 'incremental' }],
    ]);
    const authored = expandAuthoredModelPipelines(resolveModelPipelines(config), models);
    const [synthetic] = computeSyntheticModelPipelines(config, authored, models);
    expect(synthetic!.trigger).toBe('schedule');
    expect(synthetic!.cron).toBe('0 6 * * *');
  });
});
