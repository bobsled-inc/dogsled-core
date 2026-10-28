import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toYaml } from '@bobsled-inc/protocol';

import { runSdkGenerate, createSdkGenerateCommand } from '../../src/cli/sdk-generate-cmd.js';

function scaffold(dir: string): void {
  mkdirSync(join(dir, 'integrations'), { recursive: true });
  mkdirSync(join(dir, 'entity-graph'), { recursive: true });
  writeFileSync(join(dir, 'model-spec.yml'), 'mdm_dir: entity-graph\n');
  writeFileSync(
    join(dir, 'integrations/duckdb.yml'),
    `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: t.duckdb\n`
  );
  writeFileSync(
    join(dir, 'entity-graph/customer.yml'),
    `spec_version: '0.2'
name: customer
type: resolution
description: Test customer resolution
inputs:
  - ref: crm.customers
    role: internal
    trust_tier: silver
    id_fields: [id]
standardize:
  - field: email
    transforms: [lowercase]
blocking:
  rules:
    - name: by_email
      key: standardized_email
deterministic_rules:
  - name: by_email_match
    conditions:
      - field: standardized_email
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0
scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: jaro_winkler
      weight: 1.0
thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`
  );
}

describe('runSdkGenerate', () => {
  let dir: string;
  let buf = '';
  const write = (s: string) => {
    buf += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-gen-'));
    buf = '';
    scaffold(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits TS files into <out> and returns a manifest', async () => {
    const result = await runSdkGenerate(
      { lang: 'ts', cwd: dir, out: 'sdk', integration: 'duckdb' },
      { write }
    );
    expect(result.ok).toBe(true);
    expect(result.entity_count).toBe(1);
    expect(result.files_written).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'sdk', 'index.ts'))).toBe(true);
    expect(existsSync(join(dir, 'sdk', 'entities/customer.ts'))).toBe(true);
    const customerFile = readFileSync(join(dir, 'sdk', 'entities/customer.ts'), 'utf8');
    expect(customerFile).toContain(
      `type CustomerId = string & { readonly __brand: 'CustomerId' };`
    );
  });

  it('--ir-only skips file writes but still validates IR', async () => {
    const result = await runSdkGenerate(
      { lang: 'ts', cwd: dir, irOnly: true, integration: 'duckdb', json: true },
      { write }
    );
    expect(result.files_written).toBe(0);
    expect(buf).toContain('"ir_version": "1.0"');
  });

  it('--ir-only emits JSON/YAML-equivalent receipts', async () => {
    await runSdkGenerate(
      { lang: 'ts', cwd: dir, irOnly: true, integration: 'duckdb', json: true },
      { write }
    );
    const jsonBuf = buf;
    buf = '';
    await runSdkGenerate(
      { lang: 'ts', cwd: dir, irOnly: true, integration: 'duckdb', yaml: true },
      { write }
    );
    expect(buf).toBe(toYaml(JSON.parse(jsonBuf)) + '\n');
  });

  it('emits machine-readable YAML with --yaml', async () => {
    await runSdkGenerate(
      { lang: 'ts', cwd: dir, out: 'sdk2', integration: 'duckdb', yaml: true },
      { write }
    );
    expect(buf).toMatch(/^ok: true/m);
    expect(buf).toMatch(/^ir_version:/m);
    expect(buf).toMatch(/^manifest:/m);
  });

  it('rejects --lang python with CommandError(2)', async () => {
    await expect(
      runSdkGenerate(
        // @ts-expect-error testing CLI input rejection
        { lang: 'python', cwd: dir, integration: 'duckdb' },
        { write }
      )
    ).rejects.toThrow(/--lang python is not supported/);
  });
});

describe('createSdkGenerateCommand', () => {
  it('exposes --lang, --out, --ir-only, --json, --yaml flags', () => {
    const cmd = createSdkGenerateCommand();
    const opts = cmd.options.map((o) => o.long);
    expect(opts).toContain('--lang');
    expect(opts).toContain('--out');
    expect(opts).toContain('--ir-only');
    expect(opts).toContain('--json');
    expect(opts).toContain('--yaml');
  });
});
