import {
  assertValidProjectIndex,
  compareProjectPaths,
  entriesOfKind,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import { ProjectGuideValidationError } from './errors.js';
import { parseProjectGuide } from './guide.js';
import { PROJECT_GUIDE_MAX_FILE_BYTES, type ProjectGuide } from './schema.js';

export interface LoadIndexedProjectGuidesOptions {
  maxFileBytes?: number;
}

/** Load and validate every indexed Project guide without changing its bytes. */
export function loadIndexedProjectGuides(
  index: ProjectIndex,
  options: LoadIndexedProjectGuidesOptions = {}
): readonly ProjectGuide[] {
  assertValidProjectIndex(index);
  const maxFileBytes = options.maxFileBytes ?? PROJECT_GUIDE_MAX_FILE_BYTES;
  const guides: ProjectGuide[] = [];
  const issues: Array<{ path: string; message: string }> = [];

  for (const entry of entriesOfKind(index, 'guide')) {
    const byteLength = Buffer.byteLength(entry.content, 'utf8');
    if (byteLength > maxFileBytes) {
      issues.push({
        path: entry.path,
        message: `file exceeds maximum of ${maxFileBytes} bytes`,
      });
      continue;
    }
    try {
      guides.push(parseProjectGuide(entry.content, entry.path));
    } catch (error) {
      if (error instanceof ProjectGuideValidationError) issues.push(...error.issues);
      else throw error;
    }
  }

  if (issues.length > 0) throw new ProjectGuideValidationError(issues);
  return guides.sort((left, right) => compareProjectPaths(left.path, right.path));
}

/** Guides that apply to an asset, from the Project root to its own directory. */
export function projectGuideChainForAsset(
  guides: readonly ProjectGuide[],
  assetPath: string
): readonly ProjectGuide[] {
  const normalizedAssetPath = assetPath.replaceAll('\\', '/');
  const assetDirectories = new Set(['']);
  const segments = normalizedAssetPath.split('/').slice(0, -1);
  let directory = '';
  for (const segment of segments) {
    directory = directory ? `${directory}/${segment}` : segment;
    assetDirectories.add(directory);
  }
  return guides
    .filter((guide) => {
      const directory = guide.path.includes('/')
        ? guide.path.slice(0, guide.path.lastIndexOf('/'))
        : '';
      return assetDirectories.has(directory);
    })
    .sort((left, right) => {
      const leftDepth = left.path.split('/').length;
      const rightDepth = right.path.split('/').length;
      return leftDepth - rightDepth || compareProjectPaths(left.path, right.path);
    });
}
