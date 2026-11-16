import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ActionSpecSchema } from '@bobsled-inc/extractor/extractor';
import { entriesOfKind, entryFilePath, type ProjectIndex } from '@bobsled-inc/project-index';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';
import YAML from 'yaml';

import { listBuiltInActionFiles } from './loader.js';

import type { InputFieldDefinition } from '@bobsled-inc/extractor/core';
import type { ActionSpec, ActionTransport } from '@bobsled-inc/extractor/extractor';

export interface Action {
  name: string;
  qualifiedName: string;
  integration?: string;
  transport: ActionTransport;
  tags: string[];
  description: string;
  inputs: Record<string, InputFieldDefinition>;
  spec: ActionSpec;
  filePath: string;
}

export interface ActionFilter {
  integration?: string;
  tags?: string[];
  transport?: ActionTransport;
}

export type ActionLookupResult =
  | { kind: 'found'; action: Action }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; actions: Action[] };

const MAX_ACTION_SPEC_SIZE = 1_024 * 1_024;

function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function parseActionFile(filePath: string, sourceIntegration?: string): Action {
  const stats = statSync(filePath);
  if (stats.size > MAX_ACTION_SPEC_SIZE) {
    throw new Error(`Action spec ${filePath} exceeds maximum size of 1 MB`);
  }

  return parseActionDocument(
    YAML.parse(readFileSync(filePath, 'utf-8')) as unknown,
    filePath,
    sourceIntegration
  );
}

function parseActionDocument(raw: unknown, filePath: string, sourceIntegration?: string): Action {
  const parsed = ActionSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('action', filePath, parsed.error, {
        schema: ActionSpecSchema,
      })
    );
  }

  const spec = parsed.data;
  if (sourceIntegration && spec.integration && spec.integration !== sourceIntegration) {
    throw new Error(
      `Action spec ${filePath} declares integration "${spec.integration}" but is located under "${sourceIntegration}".`
    );
  }

  const integration = sourceIntegration ?? spec.integration;
  const qualifiedName = integration ? `${integration}/${spec.name}` : spec.name;

  return {
    name: spec.name,
    qualifiedName,
    integration,
    transport: spec.transport,
    tags: spec.tags,
    description: spec.description,
    inputs: spec.input,
    spec,
    filePath,
  };
}

function projectActionSpecs(
  projectActions: string | ProjectIndex | undefined
): Array<{ filePath: string; action: Action }> {
  if (!projectActions) return [];
  if (typeof projectActions === 'string') {
    return listYamlFiles(projectActions).map((filePath) => ({
      filePath,
      action: parseActionFile(filePath),
    }));
  }
  return entriesOfKind(projectActions, 'action').map((entry) => {
    const filePath = entryFilePath(projectActions, entry);
    return { filePath, action: parseActionDocument(entry.document, filePath) };
  });
}

function directoryActionSpecs(
  integrationsDir: string
): Array<{ filePath: string; action: Action }> {
  if (!existsSync(integrationsDir)) return [];
  return readdirSync(integrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort()
    .flatMap((integrationName) =>
      listYamlFiles(join(integrationsDir, integrationName, 'actions')).map((filePath) => ({
        filePath,
        action: parseActionFile(filePath, integrationName),
      }))
    );
}

function builtInActionSpecs(): Array<{ filePath: string; action: Action }> {
  return listBuiltInActionFiles().map(({ integration, label, content }) => {
    if (Buffer.byteLength(content, 'utf-8') > MAX_ACTION_SPEC_SIZE) {
      throw new Error(`Action spec ${label} exceeds maximum size of 1 MB`);
    }
    return {
      filePath: label,
      action: parseActionDocument(YAML.parse(content) as unknown, label, integration),
    };
  });
}

function collectActions(
  bundled: Array<{ filePath: string; action: Action }>,
  projectActions: string | ProjectIndex | undefined
): Action[] {
  const actions: Action[] = [];
  const seen = new Map<string, string>();

  for (const { filePath, action } of [...bundled, ...projectActionSpecs(projectActions)]) {
    const existing = seen.get(action.qualifiedName);
    if (existing) {
      throw new Error(
        `Action "${action.qualifiedName}" is defined multiple times: ${existing}, ${filePath}`
      );
    }
    seen.set(action.qualifiedName, filePath);
    actions.push(action);
  }

  return actions.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
}

/**
 * Loads action specs from an integrations directory plus project-local actions
 * into a single registry view. `projectActions` is a project index, whose
 * actions are every `type: action` file wherever it lives, identified by its
 * declared `integration` and `name`; or a directory of action specs.
 */
export function loadActions(
  integrationsDir: string,
  projectActions?: string | ProjectIndex
): Action[] {
  return collectActions(directoryActionSpecs(integrationsDir), projectActions);
}

/**
 * Same as `loadActions`, with Dogsled's built-in actions read from the data
 * embedded in the package, so no files or temporary folders are needed.
 */
export function loadBuiltInActions(projectActions?: string | ProjectIndex): Action[] {
  return collectActions(builtInActionSpecs(), projectActions);
}

/** Finds an action by fully qualified name, or by bare name when it is unambiguous. */
export function findAction(actions: Action[], qualifiedName: string): ActionLookupResult {
  const exactMatch = actions.find((action) => action.qualifiedName === qualifiedName);
  if (exactMatch) {
    return { kind: 'found', action: exactMatch };
  }

  const nameMatches = actions.filter((action) => action.name === qualifiedName);
  if (nameMatches.length === 1) {
    const match = nameMatches[0];
    if (match !== undefined) {
      return { kind: 'found', action: match };
    }
  }

  if (nameMatches.length > 1) {
    return {
      kind: 'ambiguous',
      actions: nameMatches.sort((left, right) =>
        left.qualifiedName.localeCompare(right.qualifiedName)
      ),
    };
  }

  return { kind: 'not_found' };
}

/** Filters the action registry by integration, tags, and/or transport. */
export function filterActions(actions: Action[], filter: ActionFilter): Action[] {
  return actions.filter((action) => {
    if (filter.integration && action.integration !== filter.integration) {
      return false;
    }
    if (filter.transport && action.transport !== filter.transport) {
      return false;
    }
    if (filter.tags && filter.tags.length > 0) {
      return filter.tags.every((tag) => action.tags.includes(tag));
    }
    return true;
  });
}

export function listActions(integrationName?: string): Action[] {
  const actions = loadBuiltInActions();
  return integrationName ? filterActions(actions, { integration: integrationName }) : actions;
}

export function getAction(integrationName: string, actionName: string): Action {
  const qualifiedName = `${integrationName}/${actionName}`;
  const result = findAction(listActions(integrationName), qualifiedName);
  if (result.kind === 'found') {
    return result.action;
  }
  throw new Error(`Action "${qualifiedName}" not found`);
}
