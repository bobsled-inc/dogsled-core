import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureProjectSkillAdapters,
  inspectProjectSkillAdapters,
  syncProjectSkillAdapters,
} from '../../../src/project-skills/adapters.js';

// Compatibility test: the rename never rewrites this file. A Skill copy made by either Core
// generation stays a managed copy, and a refresh leaves one marker under the current name.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiedProject(): { root: string; copy: string; current: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skill-marker-'));
  roots.push(root);
  mkdirSync(path.join(root, 'skills', 'example-skill'), { recursive: true });
  writeFileSync(
    path.join(root, 'skills', 'example-skill', 'SKILL.md'),
    `---\nname: example-skill\ndescription: Example guidance.\n---\n\n# Example\n`
  );
  expect(configureProjectSkillAdapters(root, { copy: true }).ok).toBe(true);
  const copy = path.join(root, '.agents', 'skills', 'example-skill');
  const [current] = readdirSync(copy).filter((name) => name.endsWith('-project-skill.json'));
  return { root, copy, current: current! };
}

describe('managed Skill copy markers', () => {
  it.each(['.dogsled-project-skill.json', '.bobsled-project-skill.json'])(
    'keeps a copy marked %s managed and refreshes it under the current name',
    (marker) => {
      const { root, copy, current } = copiedProject();
      renameSync(path.join(copy, current), path.join(copy, marker));
      const states = inspectProjectSkillAdapters(root).statuses.map((entry) => entry.state);
      expect(states).not.toContain('conflict');

      writeFileSync(
        path.join(root, 'skills', 'example-skill', 'SKILL.md'),
        `---\nname: example-skill\ndescription: Updated guidance.\n---\n\n# Updated\n`
      );
      expect(syncProjectSkillAdapters(root).ok).toBe(true);
      expect(readdirSync(copy).filter((name) => name.endsWith('-project-skill.json'))).toEqual([
        current,
      ]);
    }
  );
});
