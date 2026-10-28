/**
 * Smoke coverage for the fix-suggesting error codes wired through
 * `compiler/error-hints.ts`. Each test asserts the stable `[CODE]` prefix
 * shows up in the surfaced error string — that's the contract agent error
 * handlers branch on.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import YAML from 'yaml';

import { loadProjectConfig } from '../../../src/config.js';
import {
  MODEL_SPEC_ERROR_CODES,
  modelSpecHint,
  didYouMean,
  editDistance,
} from '../../../src/compiler/error-hints.js';
import { validateJsonPathStepName } from '../../../src/compiler/expr/emitter.js';
import { tokenize } from '../../../src/compiler/expr/tokenizer.js';
import { resolveRef } from '../../../src/compiler/parser.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';
import { VqSpecSchema } from '../../../src/entities/vq.js';

describe('modelSpecHint / editDistance / didYouMean', () => {
  it('prefixes a message with the stable [CODE] marker', () => {
    const out = modelSpecHint(MODEL_SPEC_ERROR_CODES.JSON_PATH_DOUBLE_ROOT, 'oops');
    expect(out).toBe('[JSON_PATH_DOUBLE_ROOT] oops');
  });

  it('edit distance returns 0 for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
  });

  it('edit distance early-exits past the cap', () => {
    expect(editDistance('aaaa', 'bbbb', 2)).toBe(3);
  });

  it('didYouMean picks the closest candidate within range', () => {
    expect(didYouMean('moduls_dir', ['models_dir', 'sources_dir'], 3)).toBe('models_dir');
  });

  it('didYouMean returns undefined when nothing is close enough', () => {
    expect(didYouMean('xyzzy', ['models_dir', 'sources_dir'], 2)).toBeUndefined();
  });
});

describe('LEGACY_TYPE_LITERAL', () => {
  it('rejects type: transform with a fix-suggesting message', () => {
    const result = TransformSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'stg_x',
      type: 'transform',
      description: 'legacy',
      grain: 'id',
      source: { ref: 'foo' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[LEGACY_TYPE_LITERAL]');
      expect(msg).toContain('type: model');
    }
  });

  it('also catches type: view (materialization type used as spec type)', () => {
    const result = TransformSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'stg_x',
      type: 'view',
      description: 'oops',
      grain: 'id',
      source: { ref: 'foo' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[LEGACY_TYPE_LITERAL]');
      expect(msg).toContain('materialization.type');
    }
  });
});

describe('VQ_TYPE_LITERAL_MISMATCH', () => {
  it("hints 'use type: vq' when an author writes 'verified_query'", () => {
    const result = VqSpecSchema.safeParse({
      spec_version: '0.2',
      type: 'verified_query',
      name: 'top_customers',
      nlq: 'Who are my top customers?',
      sql: 'SELECT * FROM {fct_orders}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[VQ_TYPE_LITERAL_MISMATCH]');
      expect(msg).toContain('type: vq');
    }
  });
});

describe('MISPLACED_TARGET_SCHEMA', () => {
  it('rejects target_schema nested under materialization (view)', () => {
    const result = TransformSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'stg_x',
      type: 'model',
      description: 'desc',
      grain: 'id',
      source: { ref: 'foo' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view', target_schema: 'ANALYTICS' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[MISPLACED_TARGET_SCHEMA]');
      expect(msg).toContain('top-level');
    }
  });

  it('rejects target_database nested under materialization (incremental)', () => {
    const result = TransformSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'stg_x',
      type: 'model',
      description: 'desc',
      grain: 'id',
      source: { ref: 'foo' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: {
        type: 'incremental',
        strategy: 'merge',
        unique_key: 'id',
        target_database: 'PROD',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[MISPLACED_TARGET_SCHEMA]');
    }
  });

  it('allows top-level target_schema (the correct placement)', () => {
    const result = TransformSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'stg_x',
      type: 'model',
      description: 'desc',
      grain: 'id',
      target_schema: 'ANALYTICS',
      source: { ref: 'foo' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    });
    expect(result.success).toBe(true);
  });
});

describe('UNKNOWN_MODEL_SPEC_CONFIG_KEY', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-model-spec-config-hint-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('suggests the closest accepted key on a typo', () => {
    fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'moduls_dir: models\n', 'utf-8');
    expect(() => loadProjectConfig(tmpDir)).toThrow(/UNKNOWN_MODEL_SPEC_CONFIG_KEY/);
    expect(() => loadProjectConfig(tmpDir)).toThrow(/did you mean "models_dir"/);
  });

  it('rejects connection: as a top-level model-spec.yml key', () => {
    fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), 'connection: snowflake\n', 'utf-8');
    expect(() => loadProjectConfig(tmpDir)).toThrow(/UNKNOWN_MODEL_SPEC_CONFIG_KEY/);
    expect(() => loadProjectConfig(tmpDir)).toThrow(/integrations\/<handle>\.yml/);
  });
});

describe('BACKTICK_IDENT', () => {
  it('rejects backtick-quoted identifiers in the expression DSL', () => {
    expect(() => tokenize('`my col` + 1')).toThrow(/BACKTICK_IDENT/);
    expect(() => tokenize('`my col` + 1')).toThrow(/raw_sql/);
  });
});

describe('JSON_PATH_DOUBLE_ROOT', () => {
  it('rejects a bare "$" reaching the path-step emitter', () => {
    expect(() => validateJsonPathStepName('$')).toThrow(/JSON_PATH_DOUBLE_ROOT/);
  });

  it('still accepts safe key names', () => {
    expect(() => validateJsonPathStepName('workspace')).not.toThrow();
    expect(() => validateJsonPathStepName('emails')).not.toThrow();
  });
});

describe('UNRESOLVED_REF_WITH_HINT', () => {
  it('suggests the integration-qualified source when bare ref matches a tail', () => {
    const sources = new Map<string, string>([
      ['ecom.orders', 'RAW.ORDERS'],
      ['ecom.customers', 'RAW.CUSTOMERS'],
    ]);
    const models = new Map<string, string>();
    const result = resolveRef('orders', sources, models);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('[UNRESOLVED_REF_WITH_HINT]');
      expect(result.error).toContain('Did you mean source "ecom.orders"');
    }
  });

  it('suggests a fuzzy-matched model on a typo', () => {
    const sources = new Map<string, string>();
    const models = new Map<string, string>([['stg_orders', 'ANALYTICS.STG_ORDERS']]);
    const result = resolveRef('stg_order', sources, models);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('[UNRESOLVED_REF_WITH_HINT]');
      expect(result.error).toContain('stg_orders');
    }
  });

  it('hints fuzzy matches for dotted source refs too', () => {
    const sources = new Map<string, string>([['ecom.orders', 'RAW.ORDERS']]);
    const result = resolveRef('ecom.order', sources);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('[UNRESOLVED_REF_WITH_HINT]');
      expect(result.error).toContain('ecom.orders');
    }
  });
});

// Sanity check that YAML.parse still rounds the spec through correctly when
// using the legacy literal — ensures errorMap fires on real-world input.
describe('LEGACY_TYPE_LITERAL via YAML round-trip', () => {
  it('catches legacy literal in raw YAML', () => {
    const raw = YAML.parse(
      [
        "spec_version: '0.2'",
        'name: stg_x',
        'type: transform',
        'description: legacy',
        'grain: id',
        'source: { ref: foo }',
        'columns: [{ name: ID, expr: ID }]',
        'materialization: { type: view }',
      ].join('\n')
    );
    const result = TransformSpecSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('[LEGACY_TYPE_LITERAL]');
    }
  });
});
