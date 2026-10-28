import { lstatSync } from 'node:fs';
import path from 'node:path';

import { configureProjectSkillAdapters } from '../project-skills/adapters.js';

import type { RenderedSetupFile } from './types.js';

export function starterProjectSkillFile(repoName: string): RenderedSetupFile {
  return {
    path: 'skills/project-overview/SKILL.md',
    preserveExisting: true,
    content: `---
type: skill
name: project-overview
description: Explain how agents should work with this Dogsled project.
triggers:
  - understand this Dogsled project
  - work with this project's pipelines
---

# ${repoName} project overview

Read \`dogsled.yml\` before changing pipeline behavior. Use the project models, Resources, Actions, and pipelines by their Dogsled names. Never place secret values in project files or output.
`,
  };
}

function adapterParentIsSafe(adapterPath: string): boolean {
  try {
    const stat = lstatSync(adapterPath);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export function configureRenderedProjectSkills(files: RenderedSetupFile[], outDir: string): void {
  if (!files.some((file) => file.path.startsWith('skills/'))) return;
  const adapterParents = ['.agents/skills', '.claude/skills'].map((relativePath) =>
    path.join(outDir, relativePath)
  );
  if (adapterParents.every(adapterParentIsSafe)) configureProjectSkillAdapters(outDir);
}
