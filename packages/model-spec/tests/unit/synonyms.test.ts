import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProject } from '../../src/api/index.js';

import { ignoredKeyWarnings } from '../../src/compiler/discarded-keys.js';
import { SourceSpecSchema, TransformSpecSchema } from '../../src/compiler/schemas.js';
import { effectiveSynonyms, mergeSynonyms } from '../../src/entities/index.js';
import { nativeSynonymProperties } from '../../src/entities/semantic-metadata.js';
import {
  exportOssieDocument,
  importOssieDocuments,
  type ExportOssieDocumentRequest,
} from '../../src/interchange/index.js';

const source = {
  spec_version: '0.2',
  type: 'source',
  source_type: 'warehouse_table',
  name: 'parcels',
  description: 'Parcels',
  connection: 'warehouse',
  table: 'ANALYTICS.RAW.PARCELS',
  synonyms: ['lots'],
  ai_context: { instructions: 'One row per parcel.', synonyms: ['Lots', 'plots'] },
  schema: {
    columns: [
      {
        name: 'parcel_id',
        type: 'VARCHAR',
        primary_key: true,
        synonyms: ['Property ID', 'raw parcel id'],
        ai_context: { synonyms: ['property  id', 'APN'], note: 'keep me' },
      },
      { name: 'county', type: 'VARCHAR', ai_context: 'County name as filed.', synonyms: ['shire'] },
      { name: 'value', type: 'DECIMAL(18,2)' },
    ],
  },
} as const;

const model = {
  spec_version: '0.2',
  type: 'model',
  name: 'valued_parcels',
  description: 'Parcels with a value',
  synonyms: ['priced parcels'],
  grain: ['parcel_id'],
  source: { ref: 'warehouse.parcels' },
  materialization: { type: 'table' },
  columns: [
    {
      name: 'parcel_id',
      type: 'VARCHAR',
      expr: 'parcels.parcel_id',
      primary_key: true,
      synonyms: ['parcel key'],
    },
    { name: 'value', type: 'DECIMAL(18,2)', expr: 'parcels.value' },
  ],
} as const;

const metric = {
  spec_version: '0.2',
  type: 'metric',
  name: 'total_value',
  description: 'Total parcel value',
  model: 'valued_parcels',
  expression: 'SUM({valued_parcels.value})',
  synonyms: ['assessed total'],
  ai_context: { synonyms: ['Assessed Total', 'portfolio value'] },
} as const;

function request(
  project: Partial<ExportOssieDocumentRequest['project']> = {},
  ossieVersion: ExportOssieDocumentRequest['ossieVersion'] = '0.2.0.dev0'
): ExportOssieDocumentRequest {
  return {
    project: {
      sources: [source],
      models: [model],
      metrics: [metric],
      relationships: [],
      addresses: {
        'warehouse.parcels': 'ANALYTICS.RAW.PARCELS',
        valued_parcels: 'ANALYTICS.MART.VALUED_PARCELS',
      },
      ...project,
    },
    semanticModelName: 'parcels',
    selection: { all: true },
    ossieVersion,
  };
}

type OssieObject = Record<string, unknown> & { ai_context?: unknown };
type OssieDocument = {
  datasets: Array<OssieObject & { name: string; fields: Array<OssieObject & { name: string }> }>;
  metrics: OssieObject[];
};

function exported(input = request()): { content: string; document: OssieDocument } {
  const result = exportOssieDocument(input);
  expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  expect(result.ok).toBe(true);
  const document = result.files[0]!.document as Record<string, unknown>;
  const semanticModel = Array.isArray(document['semantic_model'])
    ? (document['semantic_model'][0] as Record<string, unknown>)
    : document;
  return {
    content: result.files[0]!.content,
    document: semanticModel as unknown as OssieDocument,
  };
}

function without<T extends Record<string, unknown>>(value: T, ...keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function dataset(document: OssieDocument, name: string) {
  return document.datasets.find((entry) => entry.name === name)!;
}

function field(document: OssieDocument, datasetName: string, fieldName: string) {
  return dataset(document, datasetName).fields.find((entry) => entry.name === fieldName)!;
}

function imported(content: string) {
  const result = importOssieDocuments({ documents: [{ path: 'parcels.yml', content }] });
  expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  expect(result.ok).toBe(true);
  const byType = (type: string) =>
    result.files.filter((file) => file.document.type === type).map((file) => file.document);
  return { sources: byType('source'), models: byType('model'), metrics: byType('metric') };
}

describe('synonym merging', () => {
  it('keeps native entries first and drops repeats that differ only in case or spacing', () => {
    expect(
      mergeSynonyms(['Property ID', ' APN '], ['property   id', 'Parcel Key', '', 'apn'])
    ).toEqual(['Property ID', 'APN', 'Parcel Key']);
  });

  it('accepts a single string and ignores entries that are not strings', () => {
    expect(mergeSynonyms('lot', [1, 'plot', null], undefined, { synonyms: ['x'] })).toEqual([
      'lot',
      'plot',
    ]);
  });

  it('merges native synonyms with ai_context synonyms', () => {
    expect(effectiveSynonyms(source)).toEqual(['lots', 'plots']);
    expect(effectiveSynonyms({ ai_context: 'text only' })).toEqual([]);
  });
});

describe('synonyms in native schemas', () => {
  it('keeps synonyms on sources, source columns, models, model columns, and derived columns', () => {
    const parsedSource = SourceSpecSchema.parse(source);
    expect(parsedSource.synonyms).toEqual(['lots']);
    expect(parsedSource.schema.columns[0]?.synonyms).toEqual(['Property ID', 'raw parcel id']);

    const parsedModel = TransformSpecSchema.parse({
      ...model,
      derived_columns: [{ name: 'doubled', expr: 'value * 2', synonyms: ['twice value'] }],
    });
    expect(parsedModel.synonyms).toEqual(['priced parcels']);
    expect(parsedModel.columns[0]?.synonyms).toEqual(['parcel key']);
    expect(parsedModel.derived_columns?.[0]?.synonyms).toEqual(['twice value']);
  });

  it('rejects synonyms that are not a list of strings', () => {
    expect(SourceSpecSchema.safeParse({ ...source, synonyms: 'lots' }).success).toBe(false);
    expect(TransformSpecSchema.safeParse({ ...model, synonyms: [''] }).success).toBe(false);
  });
});

describe('synonyms in Ossie export', () => {
  for (const version of ['0.1.1', '0.2.0.dev0'] as const) {
    it(`writes merged synonyms to ai_context in Ossie ${version}`, () => {
      const { document, content } = exported(request({}, version));

      expect(field(document, 'parcels', 'parcel_id').ai_context).toEqual({
        note: 'keep me',
        synonyms: ['Property ID', 'raw parcel id', 'APN'],
      });
      expect(field(document, 'parcels', 'county').ai_context).toEqual({
        instructions: 'County name as filed.',
        synonyms: ['shire'],
      });
      expect(field(document, 'parcels', 'value')).not.toHaveProperty('ai_context');
      expect(dataset(document, 'parcels').ai_context).toEqual({
        instructions: 'One row per parcel.',
        synonyms: ['lots', 'plots'],
      });
      expect(dataset(document, 'valued_parcels').ai_context).toEqual({
        synonyms: ['priced parcels'],
      });
      expect(field(document, 'valued_parcels', 'parcel_id').ai_context).toEqual({
        synonyms: ['parcel key'],
      });
      expect(document.metrics[0]?.ai_context).toEqual({
        synonyms: ['assessed total', 'portfolio value'],
      });
      if (version === '0.2.0.dev0') expect(content).toContain("data: '{");
      expect(content).not.toMatch(/data: '\{[^\n]*"synonyms"/);
    });
  }

  it('exports a column that was published with synonyms', () => {
    const { document } = exported(
      request({
        sources: [
          {
            ...without(source, 'synonyms', 'ai_context'),
            schema: { columns: [{ name: 'parcel_id', type: 'VARCHAR', synonyms: ['APN'] }] },
          },
        ],
        models: [],
        metrics: [],
      })
    );
    expect(field(document, 'parcels', 'parcel_id').ai_context).toEqual({ synonyms: ['APN'] });
  });
});

describe('synonyms in Ossie import', () => {
  it('moves ai_context synonyms into native synonyms', () => {
    const { content } = exported();
    const { sources, models, metrics } = imported(content);
    const parcels = sources[0] as typeof source & Record<string, unknown>;

    expect(parcels.synonyms).toEqual(['lots', 'plots']);
    expect(parcels.ai_context).toEqual({ instructions: 'One row per parcel.' });
    expect(parcels.schema.columns[0]).toMatchObject({
      synonyms: ['Property ID', 'raw parcel id', 'APN'],
      ai_context: { note: 'keep me' },
    });
    expect(parcels.schema.columns[1]).toMatchObject({
      synonyms: ['shire'],
      ai_context: { instructions: 'County name as filed.' },
    });
    expect(parcels.schema.columns[2]).not.toHaveProperty('synonyms');
    expect(models[0]).toMatchObject({ synonyms: ['priced parcels'] });
    expect(models[0]).not.toHaveProperty('ai_context');
    expect(metrics[0]).toMatchObject({ synonyms: ['assessed total', 'portfolio value'] });
    expect(metrics[0]).not.toHaveProperty('ai_context');
  });

  it('keeps an ai_context synonyms value that is not a list of strings', () => {
    expect(nativeSynonymProperties({ synonyms: { primary: 'lots' } })).toEqual({
      ai_context: { synonyms: { primary: 'lots' } },
    });
    expect(nativeSynonymProperties({ synonyms: ['lots'] }, ['plots'])).toEqual({
      synonyms: ['plots', 'lots'],
    });
  });

  it('still reads metric synonyms from the DOGSLED extension of older exports', () => {
    const { content } = exported(request({ metrics: [without(metric, 'synonyms', 'ai_context')] }));
    const older = content.replace(
      '{"extension_version":"2","datasets"',
      '{"extension_version":"2","synonyms":["legacy total"],"datasets"'
    );
    expect(older).not.toEqual(content);
    expect(imported(older).metrics[0]).toMatchObject({ synonyms: ['legacy total'] });
  });
});

describe('synonym round trips', () => {
  const nativeProject = (files: ReturnType<typeof imported>) =>
    request({ sources: files.sources, models: files.models, metrics: files.metrics });

  it('export, import, and export again gives the same Ossie document', () => {
    const first = exported();
    const second = exported(nativeProject(imported(first.content)));
    expect(second.content).toEqual(first.content);
  });

  it('import, export, and import again gives the same native files', () => {
    const first = imported(exported().content);
    const second = imported(exported(nativeProject(first)).content);
    expect(second).toEqual(first);
  });
});

describe('ignored key warnings', () => {
  it('warns about keys a source or SQL model schema ignores', () => {
    const warnings = ignoredKeyWarnings(
      'source',
      {
        ...source,
        schema: { columns: [{ name: 'parcel_id', type: 'VARCHAR', synonym: ['typo'] }] },
      },
      'sources/parcels.yml'
    );
    expect(warnings).toEqual([
      'sources/parcels.yml: ignored unknown key schema.columns[0].synonym. Remove it or move it to a supported property.',
    ]);
    expect(
      ignoredKeyWarnings(
        'model',
        { ...model, materialization: { type: 'table', mode: 1 } },
        'm.yml'
      )
    ).toEqual([
      'm.yml: ignored unknown key materialization.mode. Remove it or move it to a supported property.',
    ]);
  });

  it('does not warn about synonyms or invalid and agentic documents', () => {
    expect(ignoredKeyWarnings('source', source, 'sources/parcels.yml')).toEqual([]);
    expect(ignoredKeyWarnings('model', model, 'models/valued_parcels.yml')).toEqual([]);
    expect(ignoredKeyWarnings('source', { type: 'source', extra: 1 }, 'bad.yml')).toEqual([]);
    expect(ignoredKeyWarnings('model', { model_kind: 'agentic', extra: 1 }, 'agentic.yml')).toEqual(
      []
    );
  });
});

describe('ignored key warnings in loaded projects', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports ignored column keys and accepts synonyms', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-spec-synonyms-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'sources'));
    fs.writeFileSync(
      path.join(root, 'sources', 'parcels.yml'),
      [
        "spec_version: '0.2'",
        'type: source',
        'source_type: warehouse_table',
        'name: parcels',
        'connection: warehouse',
        'table: raw.parcels',
        'schema:',
        '  columns:',
        '    - name: parcel_id',
        '      type: VARCHAR',
        '      synonyms: [APN]',
        '      made_up: true',
        '',
      ].join('\n')
    );

    const project = await loadProject(root, { skipIntegrations: true });

    expect(project.warnings).toHaveLength(1);
    expect(project.warnings[0]).toMatch(
      /parcels\.yml: ignored unknown key schema\.columns\[0\]\.made_up\./
    );
    expect(project.sourceColumns.size).toBe(1);
  });
});
