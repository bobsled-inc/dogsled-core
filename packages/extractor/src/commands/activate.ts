import { readFileSync } from 'node:fs';
import { stdin as input } from 'node:process';

import { Command } from 'commander';
import YAML from 'yaml';

import {
  ActionSpecSchema,
  IntegrationSpecSchema,
  type ApiAction,
  type ApiIntegrationSpec,
} from '../framework/extractor/index.js';
import {
  emitActivationMetric,
  emitActivationRecord,
  runActivateDispatcher,
  type ActivationRecord,
  type ActivationResult,
} from '../runtime/activate/index.js';
import { CommandError } from './common.js';

interface ActivateOptions {
  action: string;
  integration: string;
  projectionRef?: string;
  syncName?: string;
  dryRun?: boolean;
  limit?: string;
}

function readYaml(path: string): unknown {
  return YAML.parse(readFileSync(path, 'utf-8')) as unknown;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseRecordLines(
  raw: string,
  syncName: string,
  projectionRef: string
): ActivationRecord[] {
  const records: ActivationRecord[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    try {
      const message = JSON.parse(line) as { type?: string; record?: Record<string, unknown> };
      if (message.type !== 'RECORD' || !message.record) continue;
      records.push(message.record as ActivationRecord);
    } catch (error) {
      const result: ActivationResult = {
        entity_id: `line-${index + 1}`,
        cluster_id: `line-${index + 1}`,
        status: 'failed',
        idempotency_key: '',
        action: 'unknown',
        sync_name: syncName,
        projection_ref: projectionRef,
        duration_ms: 0,
        attempted_at: new Date().toISOString(),
        error: {
          code: 'validation_error',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
      emitActivationRecord(result);
    }
  }
  return records;
}

export function registerActivateCommand(program: Command): void {
  program
    .command('activate')
    .description('Dispatch API activation actions for RECORD JSONL read from stdin')
    .requiredOption('--action <path>', 'Path to an API action YAML spec')
    .requiredOption('--integration <path>', 'Path to the integration/source YAML spec')
    .option('--projection-ref <ref>', 'Projection ref for idempotency keys', 'stdin')
    .option('--sync-name <name>', 'Sync name for emitted activation results', 'activate')
    .option('--dry-run', 'Emit skipped activation results without dispatching HTTP requests', false)
    .option('--limit <n>', 'Maximum records to process')
    .action(async (options: ActivateOptions) => {
      const projectionRef = options.projectionRef ?? 'stdin';
      const syncName = options.syncName ?? 'activate';
      const action = ActionSpecSchema.parse(readYaml(options.action));
      if (action.transport !== 'api') {
        throw new CommandError('bobsled extract activate supports API actions only.', 2);
      }
      const integration = IntegrationSpecSchema.parse(readYaml(options.integration));
      const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new CommandError('--limit must be a positive integer.', 2);
      }

      const records = parseRecordLines(await readStdin(), syncName, projectionRef);
      const summary = await runActivateDispatcher({
        actionSpec: action as ApiAction,
        integrationSpec: integration as ApiIntegrationSpec,
        records,
        projectionRef,
        syncName,
        dryRun: options.dryRun,
        limit,
        onResult: async (result) => {
          emitActivationRecord(result);
        },
      });
      emitActivationMetric({
        sync_name: syncName,
        succeeded: summary.succeeded,
        failed: summary.failed,
        skipped: summary.skipped,
        total: records.length,
      });
    });
}
