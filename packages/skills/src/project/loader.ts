import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';

import {
  assertValidProjectIndex,
  duplicateIdentityIssues,
  entriesOfKind,
  type ProjectIndex,
  resolveProjectIndex,
} from '@bobsled-inc/project-index';

import { ProjectSkillValidationError, projectSkillError } from './errors.js';
import { loadProjectSkillPackage } from './package.js';
import {
  PROJECT_SKILL_MAX_COUNT,
  PROJECT_SKILL_MAX_FILE_BYTES,
  PROJECT_SKILL_MAX_PACKAGE_FILES,
  PROJECT_SKILL_MAX_TOTAL_BYTES,
  type ProjectSkill,
  type ProjectSkillRegistry,
} from './schema.js';

export interface LoadProjectSkillDocumentsOptions {
  maxSkills?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  /** Prebuilt project index; the project root is scanned when omitted. */
  index?: ProjectIndex;
}

const SKILL_PACKAGE_MAX_DEPTH = 32;
const SKILL_PACKAGE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);

function canonicalSkillPackagePath(entrypointPath: string): string | undefined {
  const segments = entrypointPath.split('/');
  return segments.length >= 3 && segments.at(-3) === 'skills' && segments.at(-1) === 'SKILL.md'
    ? segments.slice(0, -1).join('/')
    : undefined;
}

function readPackageResource(
  absolutePath: string,
  projectPath: string,
  maxFileBytes: number
): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(absolutePath, SKILL_PACKAGE_OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw projectSkillError(projectPath, 'symbolic links are not allowed in Skill packages');
    }
    throw projectSkillError(projectPath, `cannot read package resource: ${String(error)}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw projectSkillError(projectPath, 'package resources must be regular files');
    }
    if (stat.size > maxFileBytes) {
      throw projectSkillError(
        projectPath,
        `file is ${stat.size} bytes; maximum is ${maxFileBytes}`
      );
    }
    const content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size || fstatSync(descriptor).size !== stat.size) {
      throw projectSkillError(projectPath, 'package resource changed while it was read');
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function readSkillPackageResources(input: {
  readonly root: string;
  readonly entrypointPath: string;
  readonly skillEntryPaths: ReadonlySet<string>;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}): Array<{ readonly content: Buffer; readonly path: string }> {
  const packageDirectory = canonicalSkillPackagePath(input.entrypointPath);
  if (!packageDirectory) return [];

  const resources: Array<{ content: Buffer; path: string }> = [];
  let totalBytes = 0;
  const rootPath = path.resolve(input.root);
  const absoluteDirectory = path.resolve(rootPath, ...packageDirectory.split('/'));
  const relativeDirectory = path.relative(rootPath, absoluteDirectory);
  if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) {
    throw projectSkillError(
      input.entrypointPath,
      'Skill package directory is outside the project root'
    );
  }

  const visit = (directory: string, relativePath: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw projectSkillError(
        input.entrypointPath,
        `cannot read Skill package directory: ${String(error)}`
      );
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const resourcePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const projectPath = `${packageDirectory}/${resourcePath}`;
      const absolutePath = path.join(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw projectSkillError(projectPath, 'symbolic links are not allowed in Skill packages');
      }
      if (stat.isDirectory()) {
        if (depth >= SKILL_PACKAGE_MAX_DEPTH) {
          throw projectSkillError(
            projectPath,
            `Skill package directories may be nested at most ${SKILL_PACKAGE_MAX_DEPTH} levels deep`
          );
        }
        visit(absolutePath, resourcePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw projectSkillError(projectPath, 'package resources must be regular files');
      }
      if (input.skillEntryPaths.has(projectPath)) continue;
      if (resources.length + 2 > input.maxFiles) {
        throw projectSkillError(input.entrypointPath, `package exceeds ${input.maxFiles} files`);
      }
      const content = readPackageResource(absolutePath, projectPath, input.maxFileBytes);
      totalBytes += content.byteLength;
      if (totalBytes > input.maxTotalBytes) {
        throw projectSkillError(
          input.entrypointPath,
          `total file size exceeds ${input.maxTotalBytes} bytes`
        );
      }
      resources.push({ content, path: resourcePath });
    }
  };

  visit(absoluteDirectory, '', 0);
  return resources;
}

/**
 * Load every Project Skill in the project: each Markdown file whose front
 * matter declares `type: skill`, plus untyped `skills/<name>/SKILL.md` files.
 * A Skill is identified by its front matter `name`, wherever the file lives.
 * The project index has already refused symbolic links and paths outside the
 * project root.
 */
export function loadProjectSkillDocuments(
  projectRoot: string,
  options: LoadProjectSkillDocumentsOptions = {}
): ProjectSkillRegistry {
  const index = resolveProjectIndex(projectRoot, options.index);
  return loadIndexedProjectSkills(
    index.root === undefined ? { ...index, root: path.resolve(projectRoot) } : index,
    options
  );
}

/**
 * `loadProjectSkillDocuments` over an index the caller already built. An
 * index with blocking issues is refused, as `resolveProjectIndex` refuses it.
 */
export function loadIndexedProjectSkills(
  index: ProjectIndex,
  options: Omit<LoadProjectSkillDocumentsOptions, 'index'> = {}
): ProjectSkillRegistry {
  assertValidProjectIndex(index);
  const entries = entriesOfKind(index, 'skill');
  const maxSkills = options.maxSkills ?? PROJECT_SKILL_MAX_COUNT;
  if (entries.length > maxSkills) {
    throw projectSkillError(
      'skills',
      `the project has ${entries.length} Skills; maximum is ${maxSkills}`
    );
  }

  const maxFileBytes = options.maxFileBytes ?? PROJECT_SKILL_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? PROJECT_SKILL_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? PROJECT_SKILL_MAX_PACKAGE_FILES;
  const issues: ProjectSkillValidationError['issues'] = [];
  const skills: ProjectSkill[] = [];
  let totalBytes = 0;
  const skillEntryPaths = new Set(entries.map((entry) => entry.path));

  for (const entry of entries) {
    const byteLength = Buffer.byteLength(entry.content, 'utf8');
    if (byteLength > maxFileBytes) {
      issues.push({
        path: entry.path,
        message: `file is ${byteLength} bytes; maximum is ${maxFileBytes}`,
      });
      continue;
    }
    totalBytes += byteLength;
    if (totalBytes > maxTotalBytes) {
      issues.push({ path: 'skills', message: `total file size exceeds ${maxTotalBytes} bytes` });
      break;
    }
    try {
      const resources =
        index.root === undefined
          ? []
          : readSkillPackageResources({
              root: index.root,
              entrypointPath: entry.path,
              skillEntryPaths,
              maxFileBytes,
              maxFiles,
              maxTotalBytes: maxTotalBytes - totalBytes,
            });
      totalBytes += resources.reduce((size, resource) => size + resource.content.byteLength, 0);
      const skillPackage = loadProjectSkillPackage(
        { entrypoint: entry.content, entrypointPath: entry.path, resources },
        {
          allowLegacyName: true,
          allowNoncanonicalEntrypoint: true,
          maxFileBytes,
          maxTotalBytes,
          maxFiles,
          requireDirectoryName: false,
        }
      );
      const hasPackageMetadata =
        skillPackage.license !== undefined ||
        skillPackage.compatibility !== undefined ||
        skillPackage.metadata !== undefined ||
        skillPackage.allowedTools !== undefined;
      if (skillPackage.resources?.length === 0 && !hasPackageMetadata) {
        const { packageHash: _packageHash, resources: _resources, ...legacySkill } = skillPackage;
        skills.push(legacySkill);
      } else {
        skills.push(skillPackage);
      }
    } catch (error) {
      if (error instanceof ProjectSkillValidationError) issues.push(...error.issues);
      else throw error;
    }
  }

  const duplicates = duplicateIdentityIssues(
    skills.map((skill) => ({ path: skill.filePath, name: skill.name })),
    (skill) => skill.name.toLocaleLowerCase('en-US'),
    'Skill name'
  );
  issues.push(...duplicates.map(({ path, message }) => ({ path, message })));

  if (issues.length > 0) throw new ProjectSkillValidationError(issues);
  return { skills: skills.sort((left, right) => left.name.localeCompare(right.name, 'en-US')) };
}
