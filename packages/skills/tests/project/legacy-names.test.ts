import { describe, expect, it } from 'vitest';

import { loadProjectSkillPackage } from '../../src/project/package.js';

// Compatibility test: the rename never rewrites this file. A stored Skill keeps its sidecar
// metadata whichever Core generation named the sidecar.
const entrypoint = `---\nname: skill-creator\ndescription: Create and validate agent skills.\n---\nBody.\n`;
const sidecar =
  'triggers:\n  - sidecar-trigger\nreferences:\n  - kind: resource\n    name: sidecar_resource\n';

describe('Project Skill sidecar names', () => {
  it.each(['dogsled.yaml', 'bobsled.yaml'])('reads %s as the metadata sidecar', (name) => {
    const skill = loadProjectSkillPackage({
      entrypointPath: 'skills/skill-creator/SKILL.md',
      entrypoint,
      resources: [{ path: name, content: sidecar }],
    });
    expect(skill.triggers).toEqual(['sidecar-trigger']);
    expect(skill.references).toEqual([{ kind: 'resource', name: 'sidecar_resource' }]);
  });

  it('names the sidecar it read in a validation error', () => {
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/skill-creator/SKILL.md',
        entrypoint,
        resources: [{ path: 'dogsled.yaml', content: 'unknown: true\n' }],
      })
    ).toThrow(/dogsled\.yaml/u);
  });

  it('rejects a package with both sidecar names', () => {
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/skill-creator/SKILL.md',
        entrypoint,
        resources: [
          { path: 'dogsled.yaml', content: sidecar },
          { path: 'bobsled.yaml', content: sidecar },
        ],
      })
    ).toThrow(/keep one metadata file/u);
  });
});
