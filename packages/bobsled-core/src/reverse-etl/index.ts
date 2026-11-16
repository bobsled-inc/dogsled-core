import { ActionSpecSchema } from '@bobsled-inc/extractor/extractor';
import { loadBuiltInActions } from '@bobsled-inc/integrations';
import {
  duplicateIdentityIssues,
  entriesOfKind,
  entryFilePath,
  resolveProjectIndex,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import {
  loadProjectPipelineConfig,
  type LoadProjectPipelineConfigOptions,
} from '../runner/config/project-resolver.js';
import { isValidSchedule } from '../runner/schedule/parser.js';
import { parseSyncSpecDocument, type LoadedSyncSpec } from '../sync/spec.js';
import { validateInputMapping } from '../sync/run.js';

import type { Action } from '@bobsled-inc/integrations';
import type { ActionSpec } from '@bobsled-inc/extractor/extractor';

export {
  buildReverseEtlActionFromSpec,
  buildSalesforceUpsertAction,
  pruneUnmappedOptionalInputs,
  type BuildReverseEtlActionOptions,
  type BuildSalesforceUpsertActionOptions,
} from './build-action.js';

export type ReverseEtlAssetKind = 'sync' | 'action' | 'bobsled-config';

export interface ReverseEtlParseError {
  kind: ReverseEtlAssetKind;
  file: string;
  message: string;
}

export interface ParsedReverseEtlAction {
  name: string;
  qualifiedName: string;
  integration?: string;
  spec: ActionSpec;
  filePath: string;
}

/**
 * Host declarations forwarded unchanged to `loadProjectPipelineConfig` for the
 * pipeline-name collision check. Same names-only, off-by-default semantics as
 * Project validation.
 */
export type ReverseEtlHostDeclarations = Pick<
  LoadProjectPipelineConfigOptions,
  'declaredEnvNames' | 'hostManagedModelAuth'
>;

export interface ReverseEtlProjectAssets {
  syncs: LoadedSyncSpec[];
  actions: ParsedReverseEtlAction[];
  errors: ReverseEtlParseError[];
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseActionDocument(raw: unknown, filePath: string): ParsedReverseEtlAction {
  const parsed = ActionSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  }
  const spec = parsed.data;
  const qualifiedName = spec.integration ? `${spec.integration}/${spec.name}` : spec.name;
  return {
    name: spec.name,
    qualifiedName,
    integration: spec.integration,
    spec,
    filePath,
  };
}

function pushError(
  errors: ReverseEtlParseError[],
  kind: ReverseEtlAssetKind,
  file: string,
  error: unknown
): void {
  errors.push({ kind, file, message: formatUnknownError(error) });
}

interface LoadedActionRegistry {
  actions: Action[];
  complete: boolean;
}

function actionRegistry(
  projectRoot: string,
  project: ProjectIndex,
  errors: ReverseEtlParseError[]
): LoadedActionRegistry {
  try {
    return {
      actions: loadBuiltInActions(project),
      complete: true,
    };
  } catch (error) {
    errors.push({
      kind: 'action',
      file: projectRoot,
      message: formatUnknownError(error),
    });
    try {
      return { actions: loadBuiltInActions(), complete: false };
    } catch {
      return { actions: [], complete: false };
    }
  }
}

function findRegistryAction(actions: Action[], actionName: string): Action | ReverseEtlParseError {
  const exact = actions.find((action) => action.qualifiedName === actionName);
  if (exact) return exact;
  const bareMatches = actions.filter((action) => action.name === actionName);
  if (bareMatches.length === 1 && bareMatches[0]) return bareMatches[0];
  if (bareMatches.length > 1) {
    return {
      kind: 'sync',
      file: '',
      message: `Action "${actionName}" is ambiguous. Use one of: ${bareMatches
        .map((action) => action.qualifiedName)
        .join(', ')}`,
    };
  }
  return { kind: 'sync', file: '', message: `Action not found: ${actionName}` };
}

function validateSyncReferences(
  projectRoot: string,
  project: ProjectIndex,
  syncs: LoadedSyncSpec[],
  errors: ReverseEtlParseError[]
): void {
  const registry = actionRegistry(projectRoot, project, errors);

  for (const sync of syncs) {
    if (!isValidSchedule(sync.spec.schedule)) {
      errors.push({
        kind: 'sync',
        file: sync.filePath,
        message: `Invalid sync schedule "${sync.spec.schedule}"`,
      });
    }
  }

  if (!registry.complete || registry.actions.length === 0) {
    return;
  }

  for (const sync of syncs) {
    const action = findRegistryAction(registry.actions, sync.spec.target.action);
    if ('message' in action) {
      errors.push({ ...action, file: sync.filePath });
      continue;
    }

    try {
      validateInputMapping(sync.spec, action);
    } catch (error) {
      pushError(errors, 'sync', sync.filePath, error);
    }
  }
}

function validateBobsledConfigCollisions(
  projectRoot: string,
  project: ProjectIndex,
  syncs: LoadedSyncSpec[],
  errors: ReverseEtlParseError[],
  hostDeclarations: ReverseEtlHostDeclarations
): void {
  try {
    const loaded = loadProjectPipelineConfig({
      projectRoot,
      index: project,
      declaredEnvNames: hostDeclarations.declaredEnvNames,
      hostManagedModelAuth: hostDeclarations.hostManagedModelAuth,
    });
    const config = loaded.config;
    const pipelineNames = new Set(Object.keys(config.pipelines));
    for (const sync of syncs) {
      if (pipelineNames.has(sync.name)) {
        errors.push({
          kind: 'bobsled-config',
          file: loaded.pipelinePathByName.get(sync.name) ?? loaded.configPaths[0] ?? '.',
          message: `Sync "${sync.name}" collides with pipeline "${sync.name}" in ${loaded.pipelinePathByName.get(sync.name) ?? 'Project pipeline config'}`,
        });
      }
    }
  } catch (error) {
    pushError(errors, 'bobsled-config', '.', error);
  }
}

interface SyncFile {
  readonly name: string;
  /** Project-relative path, as duplicate messages name it. */
  readonly path: string;
  readonly filePath: string;
}

/**
 * Read the project's syncs and actions (`type: sync` / `type: action`,
 * wherever they live) and cross-check sync targets and pipeline names.
 * Malformed or unknown project files fail the whole read, and two syncs that
 * declare the same name are an error naming both files.
 */
export function parseReverseEtlProject(
  projectRoot: string,
  index?: ProjectIndex,
  hostDeclarations: ReverseEtlHostDeclarations = {}
): ReverseEtlProjectAssets {
  const project = resolveProjectIndex(projectRoot, index);
  const syncs: LoadedSyncSpec[] = [];
  const syncFiles: SyncFile[] = [];
  const actions: ParsedReverseEtlAction[] = [];
  const errors: ReverseEtlParseError[] = [];

  for (const entry of entriesOfKind(project, 'sync')) {
    const filePath = entryFilePath(project, entry);
    try {
      const spec = parseSyncSpecDocument(entry.document, filePath);
      syncs.push({ name: spec.name, filePath, spec });
      syncFiles.push({ name: spec.name, path: entry.path, filePath });
    } catch (error) {
      pushError(errors, 'sync', filePath, error);
    }
  }
  for (const issue of duplicateIdentityIssues(syncFiles, (sync) => sync.name, 'sync name')) {
    const file = syncFiles.find((sync) => sync.path === issue.path)?.filePath ?? issue.path;
    errors.push({ kind: 'sync', file, message: issue.message });
  }

  for (const entry of entriesOfKind(project, 'action')) {
    const filePath = entryFilePath(project, entry);
    try {
      actions.push(parseActionDocument(entry.document, filePath));
    } catch (error) {
      pushError(errors, 'action', filePath, error);
    }
  }

  validateSyncReferences(projectRoot, project, syncs, errors);
  validateBobsledConfigCollisions(projectRoot, project, syncs, errors, hostDeclarations);

  return {
    syncs: errors.some((error) => error.kind === 'sync')
      ? []
      : syncs.sort((a, b) => a.name.localeCompare(b.name)),
    actions: errors.some((error) => error.kind === 'action')
      ? []
      : actions.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
    errors,
  };
}
