import type { ProjectIndex } from '@bobsled-inc/project-index';
import { ModelSpecSchema } from '../agentic/model.js';
import { loadProject, selectIntegrationContexts } from './load-project.js';
import { resolvePublishedModelAddress } from './ossie-bindings.js';
import { analyzeModelDependencies } from '../compiler/model-dependency-analysis.js';
import { getPublishTarget } from '../compiler/publish-execution.js';
import { SourceSpecSchema } from '../compiler/schemas.js';
import { CommandError } from '../errors.js';
import type { NativeInterchangeInput } from '../interchange/index.js';
import { record } from '../interchange/common.js';

/** Resolve the same configured output addresses as compilation, without opening a runner. */
export async function resolveOssieExportAddresses(
  cwd: string,
  index: ProjectIndex,
  inputs: readonly NativeInterchangeInput[]
): Promise<Record<string, string>> {
  const project = await loadProject(cwd, { index, skipEntities: true });
  const addresses: Record<string, string> = Object.create(null);
  const selectedModels = inputs.flatMap(({ document }) => {
    const raw = record(document);
    if (raw['type'] !== 'model') return [];
    return [ModelSpecSchema.parse(raw)];
  });
  const contexts = selectedModels.length
    ? selectIntegrationContexts(project, { models: selectedModels.map((model) => model.name) })
    : [];
  const analysis = analyzeModelDependencies({
    models: project.models.map((node) => node.parsedSpec),
    sourceEntries: project.sourceEntries,
  });
  if (!analysis.ok) throw new CommandError(analysis.error, 2);
  for (const model of selectedModels) {
    const live =
      analysis.analyses.find((item) => item.modelName === model.name)?.executionMode === 'on_read';
    if (
      (model.model_kind !== 'agentic' && model.materialization.type === 'ephemeral') ||
      (live && !getPublishTarget(model.publish))
    ) {
      addresses[model.name] = `dogsled://models/${model.name}`;
      continue;
    }
    if (getPublishTarget(model.publish)) {
      const node = project.models.find((value) => value.name === model.name.toLowerCase());
      if (!node) throw new CommandError(`Unknown project model "${model.name}"`, 2);
      addresses[model.name] = resolvePublishedModelAddress(
        node.name,
        node.parsedSpec,
        project.integrations
      ).address;
      continue;
    }
    const candidates = contexts.filter((context) =>
      context.orderedNodes.some((node) => node.name === model.name.toLowerCase())
    );
    if (candidates.length !== 1) {
      throw new CommandError(
        `Cannot resolve one output integration for model "${model.name}". Check its source and execution settings.`,
        2
      );
    }
    const address = candidates[0]!.modelReg.get(model.name.toLowerCase());
    if (!address) throw new CommandError(`No compiled output address for model "${model.name}"`, 2);
    addresses[model.name] = address;
  }
  for (const { document } of inputs) {
    const raw = record(document);
    if (raw['type'] !== 'source') continue;
    const source = SourceSpecSchema.parse(raw);
    if (source.source_type === 'warehouse_table') {
      addresses[`${source.connection}.${source.name}`] = source.table;
    }
  }
  return addresses;
}
