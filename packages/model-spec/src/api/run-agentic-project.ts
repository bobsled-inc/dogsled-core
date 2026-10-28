import { withHostModelDeclarations } from '../agentic/host-declarations.js';
import { validateAgenticTools } from '../agentic/tool-access.js';
import { validatePublicationChecks } from '../agentic/duckdb-checks.js';
import { randomUUID } from 'node:crypto';
import {
  isCancellationError,
  throwIfCancelled,
  interpolateSecrets,
  createTokenCommandProvider,
  validateQueryTag,
} from '@bobsled-inc/connections';
import { buildSecretResolver } from '../integrations.js';
import { createWarehouseCheckpointStore } from '../agentic/warehouse-state.js';
import { createSqlAgenticPublisher } from '../agentic/sql-publisher.js';
import { executeAgenticRun, resolveAgenticModel } from '../agentic/index.js';
import { executeAgenticProbe } from '../agentic/probe.js';
import type { ResolvedAgenticModel } from '../agentic/index.js';
import {
  computeChecksum,
  stateKey,
  generateSelectSql,
  parseTransformSpecFromParsed,
  trackEphemeralModel,
  loadState,
  saveState,
} from '../compiler/index.js';
import { CommandError } from '../errors.js';
import { checkpointIntegration as resolveCheckpointIntegration } from './checkpoint-config.js';
import type { IntegrationCompileContext } from './integration-context.js';
import type { LoadedProject } from './load-project.js';
import type { RunProjectOptions, RunProjectResult } from './run-project.js';

/** Mixed dispatch is deliberately separate so the derived-only runner path stays unchanged. */
export async function runAgenticProject(
  project: LoadedProject,
  contexts: IntegrationCompileContext[],
  options: RunProjectOptions,
  runDerived: (cwd: string, options: RunProjectOptions) => Promise<RunProjectResult>
): Promise<RunProjectResult> {
  const checkpointConfig = project.config.checkpointStore;
  const checkpointIntegration = resolveCheckpointIntegration(project);
  if (options.state !== undefined && !options.agentic?.stateStore && !checkpointConfig) {
    throw new CommandError('Supplied regular state requires an agentic checkpoint store', 2);
  }
  const publisher = options.agentic?.publisher;
  const durable = !!(options.agentic?.host || publisher);
  const host = options.agentic?.host ?? options.experimentalAgenticProbe;
  if (!host) {
    throw new CommandError(
      'Agentic execution requires an agentic host and publisher, or an experimentalAgenticProbe host capability',
      2
    );
  }
  if (
    host.tokensPerAssignment !== undefined &&
    (!Number.isSafeInteger(host.tokensPerAssignment) || host.tokensPerAssignment <= 0)
  ) {
    throw new CommandError('Agentic tokensPerAssignment must be a positive safe integer', 2);
  }
  if (
    !Number.isSafeInteger(host.concurrency ?? 1) ||
    (host.concurrency ?? 1) < 1 ||
    (host.concurrency ?? 1) > 64
  ) {
    throw new CommandError('Agentic concurrency must be an integer from 1 to 64', 2);
  }
  if (
    !Number.isSafeInteger(host.minDispatchIntervalMs ?? 0) ||
    (host.minDispatchIntervalMs ?? 0) < 0 ||
    (host.minDispatchIntervalMs ?? 0) > 60000
  ) {
    throw new CommandError('Agentic minDispatchIntervalMs must be an integer from 0 to 60000', 2);
  }
  const selected = new Set(
    contexts.flatMap((context) => context.orderedNodes.map((node) => node.name))
  );
  const nodes = project.models.filter((node) => selected.has(node.name));
  const resolved = new Map<string, ResolvedAgenticModel>();
  // Validate every capability and reference before opening any runner.
  for (const node of nodes) {
    const model = node.parsedSpec;
    if (model.publish || model.execution) {
      throw new CommandError(
        'Mixed agentic probes do not support cross-warehouse execution/publication',
        2
      );
    }
    if (model.model_kind !== 'agentic') continue;
    validateAgenticTools(model, host.supportedTools);
    const context = contexts.find((entry) =>
      entry.orderedNodes.some((entry) => entry.name === node.name)
    )!;
    if (!host.supportedDialects.includes(context.dialect)) {
      throw new CommandError(
        `Agentic probe does not support warehouse dialect "${context.dialect}"`,
        2
      );
    }
    if (!durable && (model.tests?.length || model.expect.length)) {
      throw new CommandError('Agentic probe does not support authored tests or expectations', 2);
    }
    if ((model.limits.timeout_seconds ?? 0) * 1000 > 2_147_483_647) {
      throw new CommandError('Agentic probe timeout exceeds the supported timer range', 2);
    }
    if (model.plan.steps.some((step) => step.skills?.length)) {
      throw new CommandError('Agentic probe does not support authored skills', 2);
    }
    for (const ref of node.refs) {
      if (!project.models.some((entry) => entry.name === ref)) {
        throw new CommandError(`Unknown agentic model reference "${ref}"`, 2);
      }
    }
    for (const ref of node.sourceRefs) {
      if (![...project.sources.keys()].some((key) => key.toLowerCase() === ref.toLowerCase())) {
        throw new CommandError(`Unknown agentic source reference "${ref}"`, 2);
      }
    }
    if (model.plan.steps.some((step) => step.execution.mode === 'agent_loop') && !host.sources) {
      throw new CommandError('Agent loops require a scoped source host', 2);
    }
    const resolvedModel = resolveAgenticModel(model, {
      ...host,
      platform: withHostModelDeclarations(
        host.platform,
        options.secretResolver?.declaredSecretNames
      ),
    });
    resolved.set(node.name, resolvedModel);
    if (durable) {
      // Pure definition validation belongs here. Warehouse preflight runs once,
      // under this model's saved deadline and exclusive state session.
      validatePublicationChecks({
        resolved: resolvedModel,
        integration: context.integration.handle,
        target: context.modelReg.get(node.name)!,
        inputRef: model.sources[resolvedModel.steps[0]!.step.source.ref]!.ref,
      });
    }
  }
  const derivedNames = nodes
    .filter((node) => node.parsedSpec.model_kind !== 'agentic')
    .map((node) => node.name);
  const state = options.state ?? loadState(project.cwd);
  // Existing planner validates all SQL up front. A bare selector never executes agentic ancestors.
  const dryPlan = derivedNames.length
    ? await runDerived(project.cwd, {
        ...options,
        project,
        models: derivedNames,
        dryRun: true,
        state,
      })
    : undefined;
  if (dryPlan && !dryPlan.ok) return dryPlan;
  const result: RunProjectResult = {
    ok: true,
    dryRun: !!options.dryRun,
    cancelled: false,
    state,
    byIntegration: [],
    warnings: [...project.warnings],
    skipped: [],
  };
  const failed = new Set<string>();
  const ephemeral = new Map<string, string>();
  for (const node of nodes) {
    const context = contexts.find((entry) =>
      entry.orderedNodes.some((entry) => entry.name === node.name)
    )!;
    let group = result.byIntegration.find((entry) => entry.handle === context.integration.handle);
    if (!group) {
      group = {
        handle: context.integration.handle,
        dialect: context.dialect,
        targetSchema: context.targetSchema,
        targetDatabase: context.targetDatabase,
        statements: [],
        models: [],
        executionResults: [],
      };
      result.byIntegration.push(group);
    }
    if (options.signal?.aborted || result.cancelled) {
      result.cancelled = true;
      result.ok = false;
      group.executionResults!.push({ modelName: node.name, status: 'cancelled' });
      continue;
    }
    if (node.refs.some((ref) => failed.has(ref))) {
      failed.add(node.name);
      result.ok = false;
      group.executionResults!.push({
        modelName: node.name,
        status: 'skipped',
        error: 'An upstream model did not complete',
      });
      continue;
    }
    if (node.parsedSpec.model_kind !== 'agentic') {
      if (node.materialization === 'ephemeral') {
        const parsed = parseTransformSpecFromParsed(
          node.parsedSpec,
          context.registry,
          context.modelReg
        );
        if (!parsed.ok) throw new CommandError(parsed.error, 2);
        const sql = generateSelectSql(parsed.spec, context.dialect, ephemeral, {
          entryRegistry: context.entryRegistry,
        });
        trackEphemeralModel(node, sql, context.modelReg, ephemeral);
      }
      const child = await runDerived(project.cwd, {
        ...options,
        project,
        models: [node.name],
        state: result.state,
      });
      result.state = child.state;
      result.ok &&= child.ok;
      result.cancelled ||= child.cancelled;
      result.warnings.push(...child.warnings);
      for (const item of child.byIntegration) {
        group.statements.push(...item.statements);
        group.models.push(...item.models);
        group.executionResults!.push(...(item.executionResults ?? []));
        if (item.error) group.error = item.error;
      }
      if (!child.ok) failed.add(node.name);
      continue;
    }
    group.models.push({
      name: node.name,
      materializationType: durable ? 'agentic_table' : 'agentic_probe',
    });
    if (options.dryRun) continue;
    let ownedPublisher: Awaited<ReturnType<typeof createSqlAgenticPublisher>> | undefined;
    try {
      const model = resolved.get(node.name)!;
      if (
        options.fullRefresh &&
        Object.values(model.model.sources).some((source) => source.incremental)
      ) {
        throw new Error(
          'Incremental agentic cursors cannot be reset with fullRefresh; explicitly reset cursor progress before rebuilding'
        );
      }
      const inputRef = model.model.sources[model.steps[0]!.step.source.ref]!.ref;
      const executionContext = {
        ...(checkpointConfig ? { publicationSchema: checkpointConfig.schema } : {}),
        resolved: model,
        integration: context.integration.handle,
        target: context.modelReg.get(node.name)!,
        inputRef,
        inputSql: ephemeral.get(context.modelReg.get(inputRef.toLowerCase()) ?? inputRef),
        ...(model.steps.length > 1
          ? {
              inputSqlByRef: Object.fromEntries(
                Object.values(model.model.sources).flatMap(({ ref }) => {
                  const sql = ephemeral.get(context.modelReg.get(ref.toLowerCase()) ?? ref);
                  return sql === undefined ? [] : [[ref, sql]];
                })
              ),
            }
          : {}),
      };
      let stateStore = options.agentic?.stateStore;
      if (!stateStore && checkpointConfig && checkpointIntegration) {
        const secretResolver =
          options.secretResolver ?? (await buildSecretResolver(project.cwd, options.secrets));
        const integration = await interpolateSecrets(
          checkpointIntegration.integration,
          secretResolver
        );
        const credentialsTokenCommand =
          options.credentialsTokenCommand ?? process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'];
        stateStore = createWarehouseCheckpointStore(integration, {
          schema: checkpointConfig.schema,
          ...(checkpointConfig.lease_seconds === undefined
            ? {}
            : { leaseMs: checkpointConfig.lease_seconds * 1000 }),
          ...(options.signal ? { signal: options.signal } : {}),
          secretResolver,
          customRunners: options.customRunners,
          warehouse: options.warehouse,
          queryTag: validateQueryTag(options.queryTag),
          tokenProvider:
            options.tokenProvider ??
            (credentialsTokenCommand
              ? createTokenCommandProvider(credentialsTokenCommand)
              : undefined),
        });
      }
      const persistence = {
        ...options.agentic,
        ...(stateStore ? { stateStore } : {}),
        run: options.agentic?.run ?? { id: randomUUID(), mode: 'start' as const },
        projectDirectory: project.cwd,
      };
      if (durable) {
        if (!publisher) {
          const secretResolver =
            options.secretResolver ?? (await buildSecretResolver(project.cwd, options.secrets));
          const integration = await interpolateSecrets(
            context.integration.integration,
            secretResolver
          );
          const credentialsTokenCommand =
            options.credentialsTokenCommand ?? process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'];
          ownedPublisher = await createSqlAgenticPublisher(integration, {
            ...(checkpointConfig ? { systemSchema: checkpointConfig.schema } : {}),
            secretResolver,
            customRunners: options.customRunners,
            warehouse: options.warehouse,
            queryTag: validateQueryTag(options.queryTag),
            tokenProvider:
              options.tokenProvider ??
              (credentialsTokenCommand
                ? createTokenCommandProvider(credentialsTokenCommand)
                : undefined),
          });
        }
        const execution = await executeAgenticRun(host, executionContext, {
          ...persistence,
          publisher: publisher ?? ownedPublisher!,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (execution.publication !== 'confirmed') {
          throw new Error('Agentic publication is not confirmed');
        }
        throwIfCancelled(options.signal);
        result.state.models[stateKey(context.integration.handle, node.name)] = {
          lastRunAt: new Date().toISOString(),
          materialization: node.materialization,
          specChecksum: computeChecksum(JSON.stringify(node.parsedSpec)),
          priorFqName: executionContext.target,
          targetSchema: model.model.target_schema ?? context.targetSchema,
          ...((model.model.target_database ?? context.targetDatabase) !== undefined
            ? { targetDatabase: model.model.target_database ?? context.targetDatabase }
            : {}),
        };
      } else {
        await executeAgenticProbe(
          options.experimentalAgenticProbe!,
          executionContext,
          options.signal,
          persistence
        );
      }
      group.executionResults!.push({ modelName: node.name, status: 'success' });
    } catch (error) {
      result.ok = false;
      failed.add(node.name);
      const cancelled = isCancellationError(error, options.signal);
      result.cancelled ||= cancelled;
      const message = error instanceof Error ? error.message : String(error);
      group.error = message;
      group.executionResults!.push(
        Object.defineProperty(
          {
            modelName: node.name,
            status: cancelled ? ('cancelled' as const) : ('failed' as const),
            error: message,
          },
          'cause',
          { value: error, enumerable: false }
        )
      );
    } finally {
      await ownedPublisher?.close();
    }
  }
  if (!options.dryRun && options.state === undefined) saveState(project.cwd, result.state);
  return result;
}
