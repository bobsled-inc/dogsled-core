/**
 * Project files for `dogsled.yml` validation and manifest generation.
 *
 * One project index serves every check: resources are found by their declared
 * integration and name wherever they live, never by folder or filename. The
 * index has already refused symbolic links and paths outside the project.
 */

import * as path from 'node:path';

import {
  buildProjectIndex,
  configuredResourcesFolder,
  documentName,
  duplicateIdentityIssues,
  entriesOfKind,
  entryFilePath,
  resolveProjectIndex,
  resourceIntegration,
  scanProject,
  type ProjectIndex,
  type ProjectIndexEntry,
  type ProjectIndexError,
} from '@bobsled-inc/project-index';

import type { ValidationIssue } from './loader.js';

export interface BobsledProject {
  /** Absolute project root. */
  readonly root: string;
  readonly index: ProjectIndex;
  /**
   * The folder whose `<integration>/` subfolders own resources that declare
   * no integration: the extractor configuration's `resources_dir`, or
   * `resources`. The extractor resolves resources the same way.
   */
  readonly resourcesFolder: string;
}

/**
 * Open the project at `root`, reusing a prebuilt index when the caller has one.
 * A root that does not exist is an empty project, so validation reports what
 * is missing instead of failing on the directory.
 */
export function openBobsledProject(root: string, index?: ProjectIndex): BobsledProject {
  const absoluteRoot = path.resolve(root);
  const resolved = resolveProjectIndex(absoluteRoot, index ?? scanExistingProject(absoluteRoot));
  return {
    root: absoluteRoot,
    index: resolved,
    resourcesFolder: configuredResourcesFolder(resolved),
  };
}

function scanExistingProject(root: string): ProjectIndex {
  try {
    return scanProject(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return buildProjectIndex(root, []);
    throw error;
  }
}

/**
 * The problems a `ProjectIndexError` lists, as validation issues. Paths are
 * relative to `folder` when the index belongs to another project folder.
 */
export function projectFileIssues(error: ProjectIndexError, folder?: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: folder === undefined ? issue.path : path.posix.join(folder, issue.path),
    message: issue.message,
  }));
}

export interface ProjectResource {
  readonly integration: string;
  readonly name: string;
  readonly entry: ProjectIndexEntry;
  /** Absolute path of the resource file. */
  readonly filePath: string;
}

/** Every project resource that declares (or, at a conventional path, implies) its owner. */
export function projectResources(project: BobsledProject): ProjectResource[] {
  return entriesOfKind(project.index, 'resource').flatMap((entry) => {
    const integration = resourceIntegration(entry, project.resourcesFolder);
    const name = documentName(entry);
    return integration && name
      ? [{ integration, name, entry, filePath: entryFilePath(project.index, entry) }]
      : [];
  });
}

/**
 * The resource file at `resources/<source>/<name>.yml` or `.yaml`, whatever
 * integration it declares.
 */
export function resourceInSourceFolder(
  project: BobsledProject,
  source: string,
  name: string
): ProjectResource | undefined {
  const candidates = [`resources/${source}/${name}.yml`, `resources/${source}/${name}.yaml`];
  return projectResources(project).find((resource) => candidates.includes(resource.entry.path));
}

/**
 * The project resource a pipeline names. A bare name matches a resource's
 * declared `name` for the pipeline's source. A path-like name keeps its
 * original meaning: a file below the conventional `resources/<source>/` folder.
 */
export function findProjectResource(
  project: BobsledProject,
  source: string,
  name: string
): ProjectResource | undefined {
  if (/[\\/]/.test(name)) return resourceInSourceFolder(project, source, name);
  return projectResources(project).find(
    (resource) => resource.integration === source && resource.name === name
  );
}

/**
 * Resource problems that make a project's resources ambiguous: a resource
 * with no owner outside `<resources folder>/<integration>/`, and two
 * resources with the same integration and name.
 */
export function projectResourceIssues(project: BobsledProject): ValidationIssue[] {
  const unowned = entriesOfKind(project.index, 'resource')
    .filter((entry) => resourceIntegration(entry, project.resourcesFolder) === undefined)
    .map((entry) => ({
      path: entry.path,
      message: `The resource declares no integration. Add integration: <name>, or keep it under ${project.resourcesFolder || '.'}/<integration>/.`,
    }));
  const duplicates = duplicateIdentityIssues(
    projectResources(project).map((resource) => ({
      path: resource.entry.path,
      identity: `${resource.integration}/${resource.name}`,
    })),
    (resource) => resource.identity,
    'resource'
  ).map((issue) => ({ path: issue.path, message: issue.message }));
  return [...unowned, ...duplicates];
}
