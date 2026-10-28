import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import { runSdkGenerate } from '../../src/cli/sdk-generate-cmd.js';
import { parseSdkIr, emitTypeScriptSdk, readIr } from '../../src/index.js';

/**
 * Entity graph SDK acceptance fixture.
 *
 * End-to-end: scaffold a 3-entity DuckDB project (Customer / Document /
 * Person), invoke `dogsled sdk generate --lang ts`, assert (a) the IR is
 * the v1.0 shape, (b) one TS file per entity is emitted, (c) every
 * entity profile carries the typed `_quality: EntityQuality` field per
 * the Phase 8 contract, and (d) the wall-clock budget stays under 60s
 * for this fixture (the spec's 10-entity threshold is generous; 3
 * entities should finish in well under a second on the CI runner).
 */

function entitySpec(name: string): string {
  return `spec_version: '0.2'
name: ${name}
type: resolution
description: ${name} entity for the entity graph SDK acceptance fixture.
inputs:
  - ref: src.${name}s
    role: internal
    trust_tier: silver
    id_fields: [id]
standardize:
  - field: name
    transforms: [lowercase]
blocking:
  rules:
    - name: by_name
      key: standardized_name
deterministic_rules:
  - name: by_id_match
    conditions:
      - field: id
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0
scoring:
  method: weighted_features
  features:
    - field: standardized_name
      algorithm: jaro_winkler
      weight: 1.0
thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`;
}

const THREE_ENTITY_NAMES = ['customer', 'document', 'person'];
const TEN_ENTITY_NAMES = [
  'customer',
  'document',
  'person',
  'account',
  'company',
  'deal',
  'invoice',
  'ticket',
  'contract',
  'workspace',
];

function scaffold(dir: string, entityNames: readonly string[] = THREE_ENTITY_NAMES): void {
  mkdirSync(join(dir, 'integrations'), { recursive: true });
  mkdirSync(join(dir, 'entity-graph'), { recursive: true });
  writeFileSync(join(dir, 'model-spec.yml'), 'mdm_dir: entity-graph\n');
  writeFileSync(
    join(dir, 'integrations/duckdb.yml'),
    `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: t.duckdb\n`
  );
  for (const name of entityNames) {
    writeFileSync(join(dir, `entity-graph/${name}.yml`), entitySpec(name));
  }
}

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectTsFiles(path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function assertGeneratedSdkTypeChecks(sdkDir: string): void {
  const files = collectTsFiles(sdkDir);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const rendered = diagnostics
    .map((d) => {
      const file = d.file;
      const loc = file && d.start != null ? file.getLineAndCharacterOfPosition(d.start) : null;
      const where = file && loc ? `${file.fileName}:${loc.line + 1}:${loc.character + 1}` : '';
      return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    })
    .join('\n');
  expect(rendered).toBe('');
}

describe('Entity graph SDK acceptance — sdk generate end-to-end', () => {
  let dir: string;
  let buf = '';
  const write = (s: string) => {
    buf += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'egsdk-acc-'));
    // Reset captured CLI output between tests so we can assert it on a
    // per-test basis.
    buf = '';
    scaffold(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits typed TS SDK over a 3-entity ontology under the wall-clock budget', async () => {
    const start = Date.now();
    const result = await runSdkGenerate(
      { lang: 'ts', cwd: dir, out: 'sdk', integration: 'duckdb' },
      { write }
    );
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(result.ir_version).toBe('1.0');
    expect(result.entity_count).toBe(3);

    // Wall-clock budget: the target is 60s warm-cache on a
    // 10-entity production fixture. The 3-entity smoke fixture finishes
    // comfortably; we assert the full 60s envelope here so regressions
    // that approach the spec budget surface immediately rather than
    // waiting for the larger fixture to land.
    expect(elapsedMs).toBeLessThan(60_000);

    // Headline acceptance — every emitted entity profile exposes the
    // Phase 8 quality columns. EntityQuality lives in the shared
    // entities/_quality.ts file; per-entity files import it.
    const qualityFile = readFileSync(join(dir, 'sdk', 'entities', '_quality.ts'), 'utf8');
    expect(qualityFile).toContain('export interface EntityQuality {');
    for (const name of ['customer', 'document', 'person']) {
      const path = join(dir, 'sdk', 'entities', `${name}.ts`);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(`import type { EntityQuality } from './_quality.js';`);
      expect(content).toContain('_quality: EntityQuality;');
      expect(content).toContain('// IR version: 1.0');
    }
    assertGeneratedSdkTypeChecks(join(dir, 'sdk'));
  });

  it('emits typed TS SDK over a 10-entity ontology under the wall-clock budget', async () => {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'egsdk-acc-'));
    scaffold(dir, TEN_ENTITY_NAMES);

    const start = Date.now();
    const result = await runSdkGenerate(
      { lang: 'ts', cwd: dir, out: 'sdk', integration: 'duckdb' },
      { write }
    );
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(result.ir_version).toBe('1.0');
    expect(result.entity_count).toBe(10);
    expect(elapsedMs).toBeLessThan(60_000);
    assertGeneratedSdkTypeChecks(join(dir, 'sdk'));
  });

  it('emit→re-parse round-trip is stable for the IR', async () => {
    const result = await runSdkGenerate(
      { lang: 'ts', cwd: dir, out: 'sdk', integration: 'duckdb', irOnly: true, json: true },
      { write }
    );
    // The JSON manifest written to `buf` (via the test write seam)
    // carries the IR version + entity count. Assert the JSON shape so
    // the test verifies the CLI output, not just the function return.
    expect(result.ir_version).toBe('1.0');
    const cliManifest = JSON.parse(buf);
    expect(cliManifest.ir_version).toBe('1.0');
    expect(cliManifest.entity_count).toBe(3);
    expect(cliManifest.files_written).toBe(0);

    // Round-trip against the *real* IR for the scaffolded fixture instead
    // of a hand-built shape: `readIr()` exercises the same
    // `inventoryEntityGraph()` bridge that `runSdkGenerate` uses internally,
    // so this asserts the contract holds end-to-end. Building a synthetic
    // IR here would let `readIr()` / `inventoryEntityGraph()` regress
    // silently.
    const { ir } = await readIr({ cwd: dir, integration: 'duckdb' });
    const parsed = parseSdkIr(ir);
    expect(parsed.ir_version).toBe('1.0');
    expect(parsed.entities).toHaveLength(3);
    expect(parsed.polymorphic_groups).toEqual([]);

    // Emit then verify branded IDs landed on every per-entity file
    // (skip the shared _quality.ts module).
    const files = emitTypeScriptSdk(parsed, { generatedAt: '2026-05-07T00:00:00Z' });
    for (const f of files) {
      if (f.path.startsWith('entities/') && !f.path.endsWith('_quality.ts')) {
        expect(f.content).toMatch(/__brand: '[A-Z]/);
      }
    }
  });
});
