import { createHash } from 'node:crypto';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { decodeUtf8 } from './document.js';
import { ProjectSkillValidationError, projectSkillError } from './errors.js';
import { parseProjectSkill } from './parser.js';
import {
  PROJECT_SKILL_MAX_FILE_BYTES,
  PROJECT_SKILL_MAX_PACKAGE_FILES,
  PROJECT_SKILL_MAX_TOTAL_BYTES,
  ProjectSkillPackageMetadataSchema,
  ProjectSkillNameSchema,
  ProjectSkillResourceSchema,
  type ProjectSkill,
  type ProjectSkillPackageMetadata,
  type ProjectSkillResource,
} from './schema.js';
import { SKILL_SIDECAR_SPELLINGS } from './legacy-names.js';

export interface ProjectSkillPackageResourceInput {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface ProjectSkillPackageInput {
  readonly entrypointPath: string;
  readonly entrypoint: string | Uint8Array;
  readonly resources?: readonly ProjectSkillPackageResourceInput[];
}

export interface ProjectSkillPackageOptions {
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
  readonly allowNoncanonicalEntrypoint?: boolean;
  readonly allowLegacyName?: boolean;
  readonly requireDirectoryName?: boolean;
}

const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

const bytesOf = (content: string | Uint8Array) =>
  typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);

const normalizedRelativePath = (value: string, subject: string): string => {
  const normalized = value.normalize('NFC');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw projectSkillError(subject, `invalid relative package path "${value}"`);
  }
  return normalized;
};

function sortedResources(resources: readonly ProjectSkillResource[]): ProjectSkillResource[] {
  return [...resources].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function parsePackageMetadata(
  content: Buffer,
  entrypointPath: string,
  sidecarName: string
): ProjectSkillPackageMetadata {
  const sidecarPath = `${entrypointPath}:${sidecarName}`;
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(decodeUtf8(content, sidecarPath, projectSkillError), {
      uniqueKeys: true,
    });
  } catch (cause) {
    if (cause instanceof ProjectSkillValidationError) throw cause;
    throw projectSkillError(
      sidecarPath,
      `invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const parsedMetadata = ProjectSkillPackageMetadataSchema.safeParse(parsedYaml);
  if (!parsedMetadata.success) {
    throw new ProjectSkillValidationError(
      parsedMetadata.error.issues.map((issue) => ({
        path: [sidecarPath, ...issue.path.map(String)].join(':'),
        message: issue.message,
      })),
      'Project Skill package metadata'
    );
  }
  return parsedMetadata.data;
}

export function loadProjectSkillPackage(
  input: ProjectSkillPackageInput,
  options: ProjectSkillPackageOptions = {}
): ProjectSkill {
  const entrypointPath = normalizedRelativePath(input.entrypointPath, input.entrypointPath);
  if (!options.allowNoncanonicalEntrypoint && path.posix.basename(entrypointPath) !== 'SKILL.md') {
    throw projectSkillError(entrypointPath, 'the package entrypoint must be named SKILL.md');
  }
  const directoryName = path.posix.basename(path.posix.dirname(entrypointPath));
  const entrypointBytes = bytesOf(input.entrypoint);
  const maxFileBytes = options.maxFileBytes ?? PROJECT_SKILL_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? PROJECT_SKILL_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? PROJECT_SKILL_MAX_PACKAGE_FILES;
  const inputResources = input.resources ?? [];
  if (entrypointBytes.byteLength > maxFileBytes) {
    throw projectSkillError(entrypointPath, `file exceeds ${maxFileBytes} bytes`);
  }
  if (inputResources.length + 1 > maxFiles) {
    throw projectSkillError(entrypointPath, `package exceeds ${maxFiles} files`);
  }

  let totalBytes = entrypointBytes.byteLength;
  const resources: ProjectSkillResource[] = [];
  const seen = new Set([path.posix.basename(entrypointPath)]);
  let packageMetadataBytes: Buffer | undefined;
  let packageMetadataName: string | undefined;
  for (const resource of inputResources) {
    const resourcePath = normalizedRelativePath(resource.path, entrypointPath);
    if (seen.has(resourcePath)) {
      throw projectSkillError(entrypointPath, `duplicate package path "${resourcePath}"`);
    }
    seen.add(resourcePath);
    const content = bytesOf(resource.content);
    if (SKILL_SIDECAR_SPELLINGS.includes(resourcePath)) {
      if (packageMetadataName) {
        throw projectSkillError(
          entrypointPath,
          `package has both "${packageMetadataName}" and "${resourcePath}"; keep one metadata file`
        );
      }
      packageMetadataBytes = content;
      packageMetadataName = resourcePath;
    }
    if (content.byteLength > maxFileBytes) {
      throw projectSkillError(
        `${entrypointPath}:${resourcePath}`,
        `file exceeds ${maxFileBytes} bytes`
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw projectSkillError(entrypointPath, `package exceeds ${maxTotalBytes} bytes`);
    }
    resources.push(
      ProjectSkillResourceSchema.parse({
        path: resourcePath,
        contentHash: sha256(content),
        byteLength: content.byteLength,
      })
    );
  }

  const paths = [...seen];
  for (const packagePath of paths) {
    if (
      paths.some(
        (candidate) => candidate !== packagePath && candidate.startsWith(`${packagePath}/`)
      )
    ) {
      throw projectSkillError(
        entrypointPath,
        `package path conflicts with a nested file: "${packagePath}"`
      );
    }
  }

  const packageMetadata =
    packageMetadataBytes && packageMetadataName
      ? parsePackageMetadata(packageMetadataBytes, entrypointPath, packageMetadataName)
      : undefined;
  const skill = parseProjectSkill(decodeUtf8(entrypointBytes, entrypointPath, projectSkillError), {
    ...(options.requireDirectoryName === false ? {} : { directoryName }),
    filePath: entrypointPath,
    ...(packageMetadata ? { packageMetadata } : {}),
  });
  if (!options.allowLegacyName && !ProjectSkillNameSchema.safeParse(skill.name).success) {
    throw projectSkillError(
      entrypointPath,
      'the package Skill name must use lower-case kebab-case'
    );
  }
  const orderedResources = sortedResources(resources);
  const packageHash = sha256(
    Buffer.from(
      JSON.stringify({
        entrypoint: { contentHash: sha256(entrypointBytes), path: entrypointPath },
        resources: orderedResources.map(({ byteLength, contentHash, path: resourcePath }) => ({
          byteLength,
          contentHash,
          path: resourcePath,
        })),
      }),
      'utf8'
    )
  );
  return { ...skill, packageHash, resources: orderedResources };
}

export function loadProjectSkillPackages(
  packages: readonly ProjectSkillPackageInput[],
  options: ProjectSkillPackageOptions = {}
): readonly ProjectSkill[] {
  const skills = packages.map((skillPackage) => loadProjectSkillPackage(skillPackage, options));
  const names = new Set<string>();
  for (const skill of skills) {
    const normalized = skill.name.toLocaleLowerCase('en-US');
    if (names.has(normalized)) {
      throw projectSkillError(skill.filePath, `duplicate Skill name "${skill.name}"`);
    }
    names.add(normalized);
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}
