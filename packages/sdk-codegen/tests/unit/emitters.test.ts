import { describe, it, expect } from 'vitest';

import {
  SDK_CODEGEN_VERSION,
  SDK_IR_VERSION,
  parseSdkIr,
  emitTypeScriptSdk,
  emitPythonSdk,
} from '../../src/index.js';

const FIXTURE_IR = {
  ir_version: SDK_IR_VERSION,
  entities: [
    {
      name: 'Customer',
      primary_key: 'entity_id',
      branded_id_type: 'CustomerId',
      profile_attrs: [
        { name: 'domain', type: 'string', nullable: false },
        { name: 'annual_revenue', type: 'number', nullable: true },
      ],
      quality_columns: [
        'confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
      ],
      relationships_as_left: ['competes_with'],
      relationships_as_right: ['mentioned_in'],
      capabilities: { match: true },
    },
    // Two entities so the barrel `export *` would surface a duplicate
    // EntityQuality re-export collision if the emitter regressed
    //.
    {
      name: 'Document',
      primary_key: 'entity_id',
      branded_id_type: 'DocumentId',
      profile_attrs: [{ name: 'title', type: 'string', nullable: true }],
      quality_columns: [
        'confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
      ],
      relationships_as_left: [],
      relationships_as_right: ['mentions'],
      capabilities: { match: false },
    },
  ],
  relationships: [],
  polymorphic_groups: [] as never[],
  dialect_capabilities: {
    supports_json_path: true,
    supports_full_text: true,
    supports_vector: true,
  },
};

describe('parseSdkIr', () => {
  it('accepts a valid v1.0 IR', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    expect(ir.ir_version).toBe('1.0');
    expect(ir.entities).toHaveLength(2);
    expect(ir.polymorphic_groups).toEqual([]);
  });

  it('rejects unknown IR versions', () => {
    expect(() => parseSdkIr({ ...FIXTURE_IR, ir_version: '2.0' })).toThrow();
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(() => parseSdkIr({ ...FIXTURE_IR, extra: 'nope' })).toThrow();
  });
});

describe('emitTypeScriptSdk', () => {
  it('emits index + shared _quality + one file per entity', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    expect(files.find((f) => f.path === 'index.ts')).toBeDefined();
    expect(files.find((f) => f.path === 'runtime.ts')).toBeDefined();
    expect(files.find((f) => f.path === 'client.ts')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/_quality.ts')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/Customer.ts')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/Document.ts')).toBeDefined();
  });

  it('emits EntityQuality only in the shared _quality file (no barrel collision)', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const occurrences = files.filter((f) => f.content.includes('export interface EntityQuality {'));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.path).toBe('entities/_quality.ts');
    // Every per-entity file imports rather than re-declares it.
    const entityFiles = files.filter(
      (f) => f.path.startsWith('entities/') && f.path !== 'entities/_quality.ts'
    );
    expect(entityFiles.length).toBeGreaterThan(0);
    for (const f of entityFiles) {
      expect(f.content).toContain(`import type { EntityQuality } from './_quality.js';`);
    }
  });

  it('emits branded id types and profile interfaces per entity', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const customerFile = files.find((f) => f.path === 'entities/Customer.ts');
    expect(customerFile?.content).toContain(
      `export type CustomerId = string & { readonly __brand: 'CustomerId' };`
    );
    expect(customerFile?.content).toContain('entity_id: CustomerId;');
    expect(customerFile?.content).toContain(
      `export const CUSTOMER_RELATIONSHIPS = ["competes_with","mentioned_in"] as const;`
    );
    expect(customerFile?.content).toContain(
      `export type CustomerRelationshipName = typeof CUSTOMER_RELATIONSHIPS[number];`
    );
    expect(customerFile?.content).toContain('domain: string;');
    expect(customerFile?.content).toContain('annual_revenue: number | null;');
    const docFile = files.find((f) => f.path === 'entities/Document.ts');
    expect(docFile?.content).toContain('title: string | null;');
  });

  it('honors non-default primary_key names in emitted profiles and filters', () => {
    const ir = parseSdkIr({
      ...FIXTURE_IR,
      entities: [
        {
          name: 'Customer',
          primary_key: 'customer_uuid',
          branded_id_type: 'CustomerId',
          profile_attrs: [{ name: 'domain', type: 'string', nullable: false }],
          quality_columns: [
            'confidence',
            'freshness_age_seconds',
            'source_diversity',
            'profile_coverage',
          ],
        },
      ],
    });
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const customerFile = files.find((f) => f.path === 'entities/Customer.ts');
    const clientFile = files.find((f) => f.path === 'client.ts');
    expect(customerFile?.content).toContain('customer_uuid: CustomerId;');
    expect(customerFile?.content).not.toContain('entity_id: CustomerId;');
    expect(clientFile?.content).toContain('customer_uuid?: CustomerId;');
    expect(clientFile?.content).not.toContain('entity_id?: CustomerId;');
  });

  it('emits a typed executor-backed client surface', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const runtimeFile = files.find((f) => f.path === 'runtime.ts');
    const clientFile = files.find((f) => f.path === 'client.ts');

    expect(runtimeFile?.content).toContain('export interface DogsledEntityExecutor');
    expect(runtimeFile?.content).toContain('get?<TProfile>(request: EntityGetRequest)');
    expect(runtimeFile?.content).toContain('match?<TRecord extends object>');
    expect(runtimeFile?.content).toContain('export interface EntityMatchOptions');
    expect(runtimeFile?.content).toContain('cursor?: string;');
    expect(runtimeFile?.content).toContain('after(cursor: string)');
    expect(runtimeFile?.content).toContain('withDocuments()');
    expect(runtimeFile?.content).toContain('withRelationship<K extends TRelationshipName>');
    expect(runtimeFile?.content).toContain('is not valid for entity');
    expect(clientFile?.content).toContain('export function createDogsledClient');
    expect(clientFile?.content).toContain('export const RELATIONSHIPS_BY_ENTITY');
    expect(clientFile?.content).toContain('export interface CustomerFindFilter');
    expect(clientFile?.content).toContain('findBy(filter: CustomerFindFilter)');
    expect(clientFile?.content).toContain('get(id: CustomerId)');
    expect(clientFile?.content).toContain(
      'match(record: Partial<CustomerProfile>, options?: EntityMatchOptions)'
    );
    expect(clientFile?.content).not.toContain('match(record: Partial<DocumentProfile>');
    expect(clientFile?.content).toContain(
      'CustomerProfile, CustomerFindFilter, DocumentProfile, CustomerRelationshipName'
    );
  });

  it('embeds the IR version in every emitted file header', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    // Search every file rather than asserting on files[0] — emission order
    // is an implementation detail.
    const indexFile = files.find((f) => f.path === 'index.ts');
    expect(indexFile?.content).toContain(`// IR version: ${SDK_IR_VERSION}`);
    for (const f of files) {
      expect(f.content).toContain(`// IR version: ${SDK_IR_VERSION}`);
    }
  });

  it('emits the machine-readable codegen header as the first line', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const indexFile = files.find((f) => f.path === 'index.ts');
    expect(indexFile?.content.split('\n')[0]).toBe(
      `// @bobsled-inc/sdk-codegen codegen_version=${SDK_CODEGEN_VERSION} ir_version=${SDK_IR_VERSION}`
    );
  });
});

describe('emitPythonSdk', () => {
  it('emits __init__.py + entities/__init__.py + shared _quality + per-entity', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    expect(files.find((f) => f.path === '__init__.py')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/__init__.py')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/_quality.py')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/Customer.py')).toBeDefined();
    expect(files.find((f) => f.path === 'entities/Document.py')).toBeDefined();
  });

  it('emits NewType branded ids and pydantic profile model with required imports', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    // Customer.py — full assertions on imports, branded id, profile model.
    const customerFile = files.find((f) => f.path === 'entities/Customer.py');
    expect(customerFile?.content).toContain('from typing import NewType, Optional');
    expect(customerFile?.content).toContain('from pydantic import BaseModel');
    expect(customerFile?.content).toContain('from ._quality import EntityQuality');
    expect(customerFile?.content).toContain(`CustomerId = NewType('CustomerId', str)`);
    expect(customerFile?.content).toContain('class CustomerProfile(BaseModel):');
    expect(customerFile?.content).toContain('entity_id: CustomerId');
    expect(customerFile?.content).toContain('domain: str');
    expect(customerFile?.content).toContain('annual_revenue: Optional[float]');
    // Document.py — same import + structural shape so a regression on the
    // second emitted file doesn't slip through.
    const documentFile = files.find((f) => f.path === 'entities/Document.py');
    expect(documentFile?.content).toContain('from typing import NewType, Optional');
    expect(documentFile?.content).toContain('from pydantic import BaseModel');
    expect(documentFile?.content).toContain('from ._quality import EntityQuality');
    expect(documentFile?.content).toContain(`DocumentId = NewType('DocumentId', str)`);
    expect(documentFile?.content).toContain('class DocumentProfile(BaseModel):');
    expect(documentFile?.content).toContain('_quality: EntityQuality');
    expect(documentFile?.content).not.toMatch(/^    quality: EntityQuality$/m);
  });

  it('honors non-default primary_key names in emitted Python profiles', () => {
    const ir = parseSdkIr({
      ...FIXTURE_IR,
      entities: [
        {
          name: 'Customer',
          primary_key: 'customer_uuid',
          branded_id_type: 'CustomerId',
          profile_attrs: [{ name: 'domain', type: 'string', nullable: false }],
          quality_columns: [
            'confidence',
            'freshness_age_seconds',
            'source_diversity',
            'profile_coverage',
          ],
        },
      ],
    });
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const customerFile = files.find((f) => f.path === 'entities/Customer.py');
    expect(customerFile?.content).toContain('customer_uuid: CustomerId');
    expect(customerFile?.content).not.toContain('entity_id: CustomerId');
    expect(customerFile?.content).toContain('_quality: EntityQuality');
  });

  it('emits EntityQuality only in the shared _quality module', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const occurrences = files.filter((f) => f.content.includes('class EntityQuality(BaseModel)'));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.path).toBe('entities/_quality.py');
  });

  it('emits the machine-readable codegen header as the first line', () => {
    const ir = parseSdkIr(FIXTURE_IR);
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const initFile = files.find((f) => f.path === '__init__.py');
    expect(initFile?.content.split('\n')[0]).toBe(
      `# @bobsled-inc/sdk-codegen codegen_version=${SDK_CODEGEN_VERSION} ir_version=${SDK_IR_VERSION}`
    );
  });
});

describe('SdkAttrType: json', () => {
  const JSON_IR = {
    ...FIXTURE_IR,
    entities: [
      {
        name: 'Doc',
        primary_key: 'entity_id',
        branded_id_type: 'DocId',
        profile_attrs: [
          { name: 'metadata', type: 'json' as const, nullable: false },
          { name: 'extras', type: 'json' as const, nullable: true },
        ],
        quality_columns: [
          'confidence',
          'freshness_age_seconds',
          'source_diversity',
          'profile_coverage',
        ],
      },
    ],
  };

  it('TypeScript emitter maps json -> unknown (and unknown | null when nullable)', () => {
    const ir = parseSdkIr(JSON_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const docFile = files.find((f) => f.path === 'entities/Doc.ts');
    expect(docFile?.content).toContain('metadata: unknown;');
    expect(docFile?.content).toContain('extras: unknown | null;');
  });

  it('Python emitter maps json -> object (and Optional[object] when nullable)', () => {
    const ir = parseSdkIr(JSON_IR);
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const docFile = files.find((f) => f.path === 'entities/Doc.py');
    expect(docFile?.content).toContain('metadata: object');
    expect(docFile?.content).toContain('extras: Optional[object]');
  });
});
