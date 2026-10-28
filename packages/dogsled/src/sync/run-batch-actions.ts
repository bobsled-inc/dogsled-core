import { computeIdempotencyKey } from '@bobsled-inc/extractor';

import { executeAction } from '../lib/action-executor.js';
import { stableJson, syncNamespace } from './idempotency.js';

import type { Action } from '@bobsled-inc/integrations';
import type { ActionResult } from '../lib/action-executor.js';

export interface BatchActionRecord {
  row: Record<string, unknown>;
  inputs: Record<string, unknown>;
  entityKey: Record<string, unknown>;
}

export interface BatchActionResult {
  record: BatchActionRecord;
  result: ActionResult;
  idempotencyKey: string;
}

export interface RunBatchActionsOptions {
  action: Action;
  records: BatchActionRecord[];
  syncName: string;
  projectionRef: string;
  dryRun?: boolean;
  projectRoot?: string;
  onResult?: (result: BatchActionResult) => Promise<void>;
}

export async function runBatchActions(
  options: RunBatchActionsOptions
): Promise<BatchActionResult[]> {
  const results: BatchActionResult[] = [];
  for (const record of options.records) {
    const idempotencyKey = computeIdempotencyKey({
      action: options.action.qualifiedName,
      targetRecordKey: stableJson(record.entityKey),
      projectionRef: options.projectionRef,
      namespace: syncNamespace(options.syncName),
    });
    const result = await executeAction(options.action, record.inputs, {
      dryRun: options.dryRun,
      projectRoot: options.projectRoot,
    });
    const batchResult = { record, result, idempotencyKey };
    results.push(batchResult);
    await options.onResult?.(batchResult);
  }
  return results;
}
