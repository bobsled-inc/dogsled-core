import * as path from 'node:path';

import { getErrorMessage } from '../framework/core/shared.js';
import { CommandError } from '@bobsled-inc/protocol';

import { ExtractorClient } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import { resolveExtractIntentPlan } from '../runtime/extract-intents.js';
import { McpExtractorClient } from '../runtime/mcp-client.js';
import { classifyFailureReason, serializeExtractorErrorCause } from '../runtime/errors.js';
import { buildRunSummary, type ResourceResult } from '../runtime/run-summary.js';
import { logSchemaBehaviorDefaultWarning } from '../runtime/schema-diagnostics.js';

import { assertPathContained, type CommandContext } from './common.js';
import type { Emitter } from '../runtime/emitter.js';
import type { StateStore } from '../runtime/state.js';
import type { ExtractorState } from '../types/index.js';
import type { ExtractOptions, ExtractResourceParams, ExtractResourceResult } from './extract.js';

export async function runExtractIntentPlan({
  ctx,
  logger,
  emitter,
  state,
  stateStore,
  opts,
  extractResource,
}: {
  ctx: CommandContext;
  logger: ControlLogger;
  emitter: Emitter;
  state: ExtractorState;
  stateStore: StateStore;
  opts: ExtractOptions;
  extractResource: (params: ExtractResourceParams) => Promise<ExtractResourceResult>;
}): Promise<void> {
  const resolvedPlan = await resolveExtractIntentPlan(ctx, opts.plan!);
  for (const warning of resolvedPlan.warnings) {
    await logger.warn(warning);
  }

  if (resolvedPlan.total_estimated_credits > resolvedPlan.plan.budget.max_estimated_credits) {
    if (resolvedPlan.plan.budget.on_exceed === 'fail') {
      throw new CommandError(
        `Plan "${resolvedPlan.planName}" exceeds budget: estimated ${resolvedPlan.total_estimated_credits} credit(s) > ${resolvedPlan.plan.budget.max_estimated_credits}.`
      );
    }
    await logger.warn(
      `Plan "${resolvedPlan.planName}" exceeds budget: estimated ${resolvedPlan.total_estimated_credits} credit(s) > ${resolvedPlan.plan.budget.max_estimated_credits}. Proceeding because on_exceed=warn.`
    );
  }

  const startedAt = new Date();
  const resourceResults: ResourceResult[] = [];
  let totalRecords = 0;
  let failedSteps = 0;

  await logger.progress('run_start', undefined, {
    plan: resolvedPlan.planName,
    steps: resolvedPlan.steps.length,
    estimated_credits: resolvedPlan.total_estimated_credits,
    estimated_requests: resolvedPlan.total_estimated_requests,
  });

  for (const step of resolvedPlan.steps) {
    await logger.metric(step.step.id, {
      estimated_requests: step.estimated_requests,
      estimated_credits: step.estimated_credits,
      estimate_confidence: step.estimate_confidence,
      seed_rows_total: step.seed_rows_total,
      seed_rows_executed: step.seed_rows_executed,
    });

    const resource = { ...step.resource, name: step.step.id };
    await logSchemaBehaviorDefaultWarning(
      logger,
      resource,
      ctx.config.default_load?.defaults?.schema_behavior
    );
    const isMcp = step.integration.transport.type !== 'http';
    const client = isMcp
      ? new McpExtractorClient({ integration: step.integration })
      : new ExtractorClient({
          integration: step.integration,
          stateDir: path.join(ctx.cwd, ctx.config.state_dir),
        });

    const stepStartedAt = Date.now();
    let stepRecords = 0;
    let stepApiCalls = 0;
    try {
      if (isMcp) {
        await (client as McpExtractorClient).connect();
      }

      await logger.info(
        `Starting plan step: ${step.step.id} (${step.step.integration}/${step.step.resource})`
      );
      await logger.progress('resource_start', step.step.id, {
        integration: step.step.integration,
        resource: step.step.resource,
      });

      await emitter.emitSchema(resource, { fullRefresh: opts.fullRefresh });
      for (const inputRow of step.inputs) {
        const result = await extractResource({
          integration: step.integration,
          integrationName: step.step.integration,
          resource,
          client,
          emitter,
          logger,
          state,
          stateStore,
          batchDir: path.join(ctx.cwd, ctx.config.batch_dir),
          opts,
          inputOverrides: inputRow.input,
          inputContext: inputRow.input,
          skipSchema: true,
          skipState: true,
        });
        stepRecords += result.recordCount;
        stepApiCalls += result.apiCalls;
      }

      const durationMs = Date.now() - stepStartedAt;
      totalRecords += stepRecords;
      await logger.metric(step.step.id, {
        records_emitted: stepRecords,
        api_calls: stepApiCalls,
        duration_ms: durationMs,
        estimated_requests: step.estimated_requests,
        estimated_credits: step.estimated_credits,
        estimate_confidence: step.estimate_confidence,
        seed_rows_total: step.seed_rows_total,
        seed_rows_executed: step.seed_rows_executed,
      });
      await logger.progress('resource_complete', step.step.id, {
        records_emitted: stepRecords,
        api_calls: stepApiCalls,
        duration_ms: durationMs,
      });
      await logger.info(
        `Completed plan step: ${step.step.id} (${stepRecords} records, ${stepApiCalls} API call(s))`
      );

      resourceResults.push({
        resource: step.step.id,
        status: 'success',
        records_emitted: stepRecords,
        api_calls: stepApiCalls,
        duration_ms: durationMs,
      });
    } catch (error) {
      failedSteps += 1;
      const durationMs = Date.now() - stepStartedAt;
      const message = getErrorMessage(error);
      const failureReason = classifyFailureReason(error);
      const cause = serializeExtractorErrorCause(error);
      totalRecords += stepRecords;
      await logger.error(`Failed plan step ${step.step.id}: ${message}`);
      await logger.progress('resource_error', step.step.id, {
        error: message,
        failure_reason: failureReason,
        ...(cause ? { cause: { ...cause } } : {}),
        records_emitted: stepRecords,
        api_calls: stepApiCalls,
      });
      resourceResults.push({
        resource: step.step.id,
        status: 'error',
        records_emitted: stepRecords,
        api_calls: stepApiCalls,
        duration_ms: durationMs,
        error: message,
        failure_reason: failureReason,
      });
    } finally {
      if (isMcp) {
        await (client as McpExtractorClient).close();
      }
    }
  }

  const summary = buildRunSummary(resolvedPlan.planName, startedAt, resourceResults);
  await logger.progress('run_complete', undefined, {
    status: summary.status,
    resources_succeeded: summary.totals.resources_succeeded,
    resources_failed: summary.totals.resources_failed,
    total_records: summary.totals.records_emitted,
    elapsed_ms: summary.elapsed_ms,
  });

  if (opts.outputDir) {
    const summaryPath = path.join(opts.outputDir, 'run_summary.json');
    assertPathContained(ctx.cwd, summaryPath, 'output-dir');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  }

  await logger.info(`Plan execution complete: ${totalRecords} total records`);
  if (failedSteps > 0) {
    process.exitCode = 1;
  }
}
