import { describe, expect, it } from 'vitest';

import { classifyProjectFile, type ProjectFileClassification } from '../../src/index.js';

function kindOf(classification: ProjectFileClassification): string | undefined {
  return classification.status === 'recognized' ? classification.entry.kind : undefined;
}

function issueCode(classification: ProjectFileClassification): string | undefined {
  return classification.status === 'invalid' ? classification.issue.code : undefined;
}

describe('classifyProjectFile — YAML types', () => {
  it.each([
    ['model', 'model'],
    ['seed', 'seed'],
    ['metric', 'metric'],
    ['relationship', 'relationship'],
    ['entity_relationship', 'entity_relationship'],
    ['vq', 'vq'],
    ['integration', 'integration'],
    ['target', 'target'],
    ['resource', 'resource'],
    ['action', 'action'],
    ['sync', 'sync'],
    ['extract-intents', 'extract-intents'],
    ['resolution', 'resolution'],
    ['relationship_ontology', 'relationship_ontology'],
    ['mention_extraction', 'mention_extraction'],
    ['relationship_extraction', 'relationship_extraction'],
    ['agent_task_profile', 'agent_task_profile'],
    ['survivorship', 'survivorship'],
    ['truthset', 'truthset'],
    ['object', 'object'],
    ['policy', 'policy'],
    ['agent', 'agent'],
    ['pipeline_config', 'pipeline_config'],
    ['model_spec_config', 'model_spec_config'],
    ['extractor_config', 'extractor_config'],
  ])('routes type: %s to the %s kind at any path', (type, kind) => {
    const classification = classifyProjectFile({
      path: 'datagolf/players/file.yml',
      content: `type: ${type}\nname: example\n`,
    });
    expect(kindOf(classification)).toBe(kind);
    expect(classification.status === 'recognized' && classification.entry.declaredType).toBe(type);
  });

  it.each(['transform', 'view', 'table', 'incremental'])(
    'routes the retired model literal %s to the model kind so the model schema can explain it',
    (type) => {
      expect(
        kindOf(classifyProjectFile({ path: 'models/a.yml', content: `type: ${type}\n` }))
      ).toBe('model');
    }
  );

  it('keeps the parsed document and the raw content on the entry', () => {
    const content = 'spec_version: "0.2"\ntype: metric\nname: revenue\n';
    const classification = classifyProjectFile({ path: 'finance/revenue.yml', content });
    expect(classification).toEqual({
      status: 'recognized',
      entry: {
        path: 'finance/revenue.yml',
        kind: 'metric',
        declaredType: 'metric',
        format: 'yaml',
        content,
        document: { spec_version: '0.2', type: 'metric', name: 'revenue' },
      },
    });
  });

  it('reports an unknown type with the file path', () => {
    const classification = classifyProjectFile({ path: 'x/y.yml', content: 'type: modle\n' });
    expect(classification).toMatchObject({
      status: 'invalid',
      issue: { path: 'x/y.yml', code: 'unknown_type' },
    });
    expect(classification.status === 'invalid' && classification.issue.message).toContain(
      'Unknown type "modle"'
    );
  });

  it.each(['type: 3\n', 'type: ""\n', 'type: [model]\n', 'type:\n'])(
    'reports a non-string or empty type (%j)',
    (content) => {
      expect(issueCode(classifyProjectFile({ path: 'a/b.yml', content }))).toBe('invalid_type');
    }
  );

  it('lets an explicit type override a conventional ancestor folder', () => {
    expect(
      kindOf(
        classifyProjectFile({
          path: 'golf/datagolf/pga/models/item.yml',
          content: 'type: metric\nname: item\n',
        })
      )
    ).toBe('metric');
  });
});

describe('classifyProjectFile — type: source', () => {
  it.each([
    ['spec_version: "0.2"\n', 'source'],
    ["spec_version: '2'\n", 'integration'],
    ['spec_version: 2\n', 'integration'],
    ['source_type: warehouse_table\n', 'source'],
    ['source_type: api_resource\n', 'source'],
    ['source_type: custom_api\n', 'integration'],
    ['source_type: custom_mcp\n', 'integration'],
    ['transports: []\n', 'integration'],
    ['dogsled_source_kind: snowflake\n', 'integration'],
    ['dogsled_connection_ref: warehouse\n', 'integration'],
    ['schema:\n  columns: []\n', 'source'],
  ])('classifies %j as %s', (fields, kind) => {
    expect(
      kindOf(classifyProjectFile({ path: 'data/x.yml', content: `type: source\n${fields}` }))
    ).toBe(kind);
  });

  it('lets spec_version win over conflicting fields', () => {
    const content = 'type: source\nspec_version: "0.2"\ntransports: []\n';
    expect(kindOf(classifyProjectFile({ path: 'a.yml', content }))).toBe('source');
  });

  it('reports a source that neither version nor fields can place', () => {
    const classification = classifyProjectFile({
      path: 'data/unknown.yml',
      content: 'type: source\nname: orders\n',
    });
    expect(classification).toMatchObject({
      status: 'invalid',
      issue: { path: 'data/unknown.yml', code: 'ambiguous_source' },
    });
  });
});

describe('classifyProjectFile — untyped files', () => {
  it.each([
    ['dogsled.yml', 'pipeline_config'],
    ['dogsled.yaml', 'pipeline_config'],
    ['model-spec.yml', 'model_spec_config'],
    ['extractor.yml', 'extractor_config'],
    ['extract-intents.yml', 'extract-intents'],
  ])('recognizes the conventional root file %s', (filePath, kind) => {
    const classification = classifyProjectFile({ path: filePath, content: 'pipelines: {}\n' });
    expect(kindOf(classification)).toBe(kind);
    expect(classification.status === 'recognized' && classification.entry.declaredType).toBe(
      undefined
    );
  });

  it('requires a moved pipeline config to declare its type', () => {
    expect(
      classifyProjectFile({ path: 'shared/dogsled.yml', content: 'pipelines: {}\n' })
    ).toMatchObject({
      status: 'invalid',
      issue: { path: 'shared/dogsled.yml', code: 'invalid_type' },
    });
  });

  it('infers a conventional object before checking for pipeline config cues', () => {
    expect(
      classifyProjectFile({
        path: 'golf/datagolf/pga/metrics/score.yml',
        content: 'name: score\nmodels: [rounds, players]\n',
      })
    ).toMatchObject({
      status: 'recognized',
      entry: { kind: 'metric', document: { type: 'metric', models: ['rounds', 'players'] } },
    });
  });

  it('still rejects untyped pipeline config content outside a conventional folder', () => {
    expect(
      classifyProjectFile({ path: 'settings/runtime.yml', content: 'models: [orders]\n' })
    ).toMatchObject({
      status: 'invalid',
      issue: { code: 'invalid_type', kind: 'pipeline_config' },
    });
  });

  it.each([
    ['golf/datagolf/pga/models/event.yml', 'model'],
    ['domain/sources/player.yml', 'source'],
    ['domain/integrations/feed.yml', 'integration'],
    ['domain/resources/feed/player.yml', 'resource'],
    ['domain/actions/run.yml', 'action'],
    ['domain/targets/output.yml', 'target'],
    ['domain/syncs/load.yml', 'sync'],
    ['domain/metrics/score.yml', 'metric'],
    ['domain/relationships/link.yml', 'relationship'],
    ['domain/vqs/query.yml', 'vq'],
    ['domain/agents/assistant.yml', 'agent'],
    ['domain/seeds/players.yml', 'seed'],
  ])('infers %s as %s from the nearest exact ancestor', (filePath, kind) => {
    const classification = classifyProjectFile({ path: filePath, content: 'name: example\n' });
    expect(kindOf(classification)).toBe(kind);
    expect(classification).toMatchObject({
      status: 'recognized',
      entry: { declaredType: undefined, content: 'name: example\n', document: { type: kind } },
    });
  });

  it.each(['domain/pipelines/run.yml', 'settings/runtime.yml', 'domain/notmodels/model.yml'])(
    'does not infer a kind from %s',
    (filePath) =>
      expect(classifyProjectFile({ path: filePath, content: 'name: example\n' }).status).toBe(
        'unrecognized'
      )
  );

  it('recognizes a moved configuration that declares its type', () => {
    expect(
      kindOf(
        classifyProjectFile({
          path: 'shared/dogsled.yml',
          content: 'type: pipeline_config\npipelines: {}\n',
        })
      )
    ).toBe('pipeline_config');
  });

  it('keeps an unparseable conventional file for its own loader', () => {
    expect(classifyProjectFile({ path: 'dogsled.yml', content: 'pipelines: [\n' })).toMatchObject({
      status: 'recognized',
      entry: { kind: 'pipeline_config', document: undefined },
    });
  });

  it('reports malformed YAML in an inferred folder with the path', () => {
    expect(classifyProjectFile({ path: 'models/a.yml', content: 'name: [\n' })).toMatchObject({
      status: 'invalid',
      issue: { path: 'models/a.yml', code: 'invalid_yaml' },
    });
  });

  it('rejects duplicate YAML keys', () => {
    expect(
      issueCode(classifyProjectFile({ path: 'a/b.yml', content: 'type: model\ntype: metric\n' }))
    ).toBe('invalid_yaml');
  });

  it.each(['null\n', '[]\n', 'hello\n', ''])(
    'leaves untyped non-mapping YAML %j unrecognized',
    (content) => {
      expect(classifyProjectFile({ path: 'a/b.yml', content }).status).toBe('unrecognized');
    }
  );
});

describe('classifyProjectFile — Markdown', () => {
  it('recognizes an untyped Skill at the conventional path', () => {
    expect(
      classifyProjectFile({
        path: 'skills/lookup/SKILL.md',
        content: '---\nname: lookup\ndescription: Look up\n---\nBody\n',
      })
    ).toMatchObject({
      status: 'recognized',
      entry: {
        kind: 'skill',
        declaredType: undefined,
        format: 'markdown',
        document: { type: 'skill', name: 'lookup', description: 'Look up' },
      },
    });
  });

  it('recognizes a typed Skill anywhere', () => {
    expect(
      kindOf(
        classifyProjectFile({
          path: 'datagolf/skills/player-lookup.md',
          content: '---\ntype: skill\nname: player-lookup\ndescription: Find players\n---\nBody\n',
        })
      )
    ).toBe('skill');
  });

  it('handles a byte order mark and CRLF line endings', () => {
    expect(
      kindOf(
        classifyProjectFile({
          path: 'docs/lookup.md',
          content: '\uFEFF---\r\ntype: skill\r\nname: lookup\r\n---\r\nBody\r\n',
        })
      )
    ).toBe('skill');
  });

  it('recognizes AGENTS.md at any directory depth as a Project guide', () => {
    expect(kindOf(classifyProjectFile({ path: 'AGENTS.md', content: '# Guide\n' }))).toBe('guide');
    expect(
      kindOf(classifyProjectFile({ path: 'golf/datagolf/AGENTS.md', content: '# Guide\n' }))
    ).toBe('guide');
  });

  it('recognizes a typed guide at an arbitrary Markdown path', () => {
    expect(
      kindOf(
        classifyProjectFile({
          path: 'golf/context.md',
          content: '---\ntype: guide\n---\nContext\n',
        })
      )
    ).toBe('guide');
  });

  it('recognizes a nested conventional Skill package', () => {
    expect(
      kindOf(
        classifyProjectFile({
          path: 'golf/datagolf/skills/pga/SKILL.md',
          content: '---\nname: pga\ndescription: PGA\n---\nBody\n',
        })
      )
    ).toBe('skill');
  });

  it('leaves ordinary documents unrecognized', () => {
    expect(classifyProjectFile({ path: 'README.md', content: '# Readme\n' })).toEqual({
      status: 'unrecognized',
      file: { path: 'README.md', format: 'markdown' },
    });
    expect(
      classifyProjectFile({ path: 'docs/notes.md', content: '---\ntitle: Notes\n---\nBody\n' })
        .status
    ).toBe('unrecognized');
  });

  it('recognizes an explicitly typed Project guide', () => {
    const classification = classifyProjectFile({
      path: 'docs/guide.md',
      content: '---\ntype: guide\n---\nBody\n',
    });
    expect(classification).toMatchObject({ status: 'recognized', entry: { kind: 'guide' } });
  });

  it('reports malformed front matter outside conventional paths', () => {
    expect(
      issueCode(classifyProjectFile({ path: 'docs/a.md', content: '---\ntype: [\n---\nBody\n' }))
    ).toBe('invalid_front_matter');
  });

  it('keeps malformed front matter at a conventional path for its loader', () => {
    expect(
      classifyProjectFile({
        path: 'skills/broken/SKILL.md',
        content: '---\nname: [\n---\nBody\n',
      })
    ).toMatchObject({ status: 'recognized', entry: { kind: 'skill', document: undefined } });
  });
});

describe('classifyProjectFile — paths', () => {
  it.each([
    '.github/workflows/dogsled.yml',
    'models/.draft/a.yml',
    'node_modules/pkg/a.yml',
    '.env.yml',
  ])('ignores %s', (filePath) => {
    expect(classifyProjectFile({ path: filePath, content: 'type: model\n' }).status).toBe(
      'ignored'
    );
  });

  it.each(['/abs/a.yml', 'a/../b.yml', './a.yml', 'a//b.yml', 'a\\b.yml', ''])(
    'rejects the invalid path %j',
    (filePath) => {
      expect(issueCode(classifyProjectFile({ path: filePath, content: 'type: model\n' }))).toBe(
        'invalid_path'
      );
    }
  );

  it('leaves other file formats unrecognized', () => {
    expect(classifyProjectFile({ path: 'seeds/a.csv', content: 'id\n1\n' })).toEqual({
      status: 'unrecognized',
      file: { path: 'seeds/a.csv', format: 'other' },
    });
  });

  it('matches YAML and Markdown extensions case-insensitively', () => {
    expect(kindOf(classifyProjectFile({ path: 'a/B.YAML', content: 'type: model\n' }))).toBe(
      'model'
    );
    expect(
      kindOf(classifyProjectFile({ path: 'a/B.MD', content: '---\ntype: skill\n---\nx\n' }))
    ).toBe('skill');
  });
});

describe('Ossie content detection', () => {
  it.each(['nested/arbitrary.yml', 'nested/arbitrary.yaml', 'nested/arbitrary.json'])(
    'recognizes standard content without an authored type in %s',
    (path) => {
      expect(
        classifyProjectFile({
          path,
          content: '{"version":"0.2.0.dev0","name":"orders","datasets":[]}',
        })
      ).toMatchObject({
        status: 'recognized',
        entry: { kind: 'ossie', declaredType: undefined },
      });
    }
  );

  it.each([
    'datasets: invalid\n',
    'semantic_model: []\n',
    'version: 0.2.0.dev0\nname: incomplete\n',
    'version: 0.2.0.dev0\n',
    '{"version":"0.2.0.dev0"}',
  ])('leaves schema and version validation to the owning loader', (content) =>
    expect(kindOf(classifyProjectFile({ path: 'domain/a.yml', content }))).toBe('ossie')
  );

  it.each([
    'datasets: [\n',
    '{"name":"orders","version":"0.2.0.dev0","datasets":[',
    '{"version":"0.2.0.dev0","datasets":[],}',
  ])('routes malformed candidates to their loader', (content) =>
    expect(
      classifyProjectFile({
        path: content.startsWith('{') ? 'domain/a.json' : 'domain/a.yml',
        content,
      })
    ).toMatchObject({
      status: 'recognized',
      entry: { kind: 'ossie', document: undefined },
    })
  );

  it.each(['type: model\ndatasets: []', 'spec_version: "0.2"\nsemantic_model: []'])(
    'rejects conflicting format markers',
    (content) =>
      expect(issueCode(classifyProjectFile({ path: 'a.yml', content }))).toBe('conflicting_format')
  );

  it('does not create an authored Ossie type marker', () => {
    expect(issueCode(classifyProjectFile({ path: 'a.yml', content: 'type: ossie' }))).toBe(
      'unknown_type'
    );
  });

  it.each([
    '{"name":"package","version":"1.0.0","type":"module"}',
    '{"name":"package","version":"0.1.0","type":"module"}',
    '{"nested":{"datasets":[]}}',
    '{ broken',
  ])('leaves unrelated JSON alone', (content) => {
    expect(classifyProjectFile({ path: 'package.json', content }).status).toBe('unrecognized');
  });
});
