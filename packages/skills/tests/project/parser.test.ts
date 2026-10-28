import { describe, expect, it } from 'vitest';

import { ProjectSkillValidationError, parseProjectSkill } from '../../src/project/index.js';

const validDocument = `---
name: enrich-users
description: Add usernames to user records.
triggers:
  - add usernames
references:
  - kind: model
    name: orders
---

# Enrich users

Read the model and add usernames.
`;

describe('parseProjectSkill', () => {
  it('parses and normalizes a valid document', () => {
    const skill = parseProjectSkill(validDocument, {
      filePath: 'skills/enrich-users/SKILL.md',
    });

    expect(skill).toMatchObject({
      name: 'enrich-users',
      description: 'Add usernames to user records.',
      triggers: ['add usernames'],
      references: [{ kind: 'model', name: 'orders' }],
      content: '# Enrich users\n\nRead the model and add usernames.',
      filePath: 'skills/enrich-users/SKILL.md',
    });
    expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the same hash for newline and YAML key-order differences', () => {
    const reordered = `---\r
description: Add usernames to user records.\r
references:\r
  - name: orders\r
    kind: model\r
triggers: [add usernames]\r
name: enrich-users\r
---\r
# Enrich users\r
\r
Read the model and add usernames.\r
`;
    const options = {
      filePath: 'skills/enrich-users/SKILL.md',
    };

    expect(parseProjectSkill(reordered, options).contentHash).toBe(
      parseProjectSkill(validDocument, options).contentHash
    );
  });

  it('accepts a UTF-8 byte order mark before the front matter', () => {
    const options = { filePath: 'skills/enrich-users/SKILL.md' };

    const skill = parseProjectSkill(`\uFEFF${validDocument}`, options);

    expect(skill.name).toBe('enrich-users');
    expect(skill.content).toBe('# Enrich users\n\nRead the model and add usernames.');
    expect(skill.contentHash).toBe(parseProjectSkill(validDocument, options).contentHash);
  });

  it('accepts trailing spaces and tabs after the closing front matter delimiter', () => {
    const options = { filePath: 'skills/enrich-users/SKILL.md' };

    const skill = parseProjectSkill(
      validDocument.replace('---\n\n# Enrich', '--- \t\n\n# Enrich'),
      options
    );

    expect(skill.content).toBe('# Enrich users\n\nRead the model and add usernames.');
    expect(skill.contentHash).toBe(parseProjectSkill(validDocument, options).contentHash);
  });

  it('accepts standard Agent Skills metadata and an empty body', () => {
    const document = `---
name: enrich-users
description: ${'a'.repeat(700)}
license: Apache-2.0
compatibility: Requires Python 3.11.
metadata:
  author: example
  version: "1.0"
allowed-tools: Read Bash(git:*)
---
`;

    expect(parseProjectSkill(document, { filePath: 'skills/enrich-users/SKILL.md' })).toMatchObject(
      {
        name: 'enrich-users',
        description: 'a'.repeat(700),
        license: 'Apache-2.0',
        compatibility: 'Requires Python 3.11.',
        metadata: { author: 'example', version: '1.0' },
        allowedTools: 'Read Bash(git:*)',
        content: '',
      }
    );
  });

  it('takes its identity from the front matter name, not the file path', () => {
    const skill = parseProjectSkill(
      validDocument.replace('name: enrich-users', 'type: skill\nname: enrich-users'),
      {
        filePath: 'crm/skills/users.md',
      }
    );
    expect(skill.name).toBe('enrich-users');
    expect(skill.filePath).toBe('crm/skills/users.md');
  });

  it('enforces a directory match when the caller passes directoryName', () => {
    expect(() =>
      parseProjectSkill(validDocument.replace('name: enrich-users', 'name: another-skill'), {
        directoryName: 'enrich-users',
        filePath: 'skills/enrich-users/SKILL.md',
      })
    ).toThrow(/must match directory "enrich-users"/);
  });

  it.each([
    ['unknown key', validDocument.replace('description:', 'extra: nope\ndescription:')],
    [
      'a non-skill type',
      validDocument.replace('name: enrich-users', 'type: guide\nname: enrich-users'),
    ],
    [
      'duplicate trigger',
      validDocument.replace('  - add usernames', '  - add usernames\n  - ADD USERNAMES'),
    ],
    [
      'duplicate reference',
      validDocument.replace(
        '  - kind: model\n    name: orders',
        '  - kind: model\n    name: orders\n  - kind: model\n    name: ORDERS'
      ),
    ],
  ])('rejects %s', (_label, document) => {
    expect(() =>
      parseProjectSkill(document, {
        filePath: 'skills/enrich-users/SKILL.md',
      })
    ).toThrow(ProjectSkillValidationError);
  });

  it('accepts an empty body', () => {
    expect(
      parseProjectSkill('---\nname: enrich-users\ndescription: enrich the user profile\n---\n', {
        filePath: 'skills/enrich-users/SKILL.md',
      }).content
    ).toBe('');
  });
});
