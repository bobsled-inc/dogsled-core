import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveLoadFromResource } from '../../src/runtime/load-resolver.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const SNOWFLAKE_INTEGRATION = `
spec_version: "1"
auth_env_vars: [SF_ACCOUNT, SF_KEY_PASS, SF_KEY_PATH, SF_USER, SF_WH]
type: integration
name: snowflake_prod
source_type: snowflake
connection:
  account_identifier: "\${{ env.SF_ACCOUNT }}"
  warehouse: "\${{ env.SF_WH }}"
  user: "\${{ env.SF_USER }}"
  role: READER_ROLE
auth:
  type: rsa_key
  private_key_path: "\${{ env.SF_KEY_PATH }}"
  private_key_passphrase: "\${{ env.SF_KEY_PASS }}"
`;

const BIGQUERY_INTEGRATION = `
spec_version: "1"
auth_env_vars: [GOOGLE_APPLICATION_CREDENTIALS]
type: integration
name: bigquery_prod
source_type: bigquery
connection:
  project_id: gcp-prod
  dataset: raw
  location: us-central1
auth:
  type: service_account
  credentials: "\${{ env.GOOGLE_APPLICATION_CREDENTIALS }}"
`;

const API_INTEGRATION = `
spec_version: "1"
type: integration
name: linear_prod
source_type: api
transport:
  base_url: https://api.linear.app
`;

const ENV = {
  SF_ACCOUNT: 'acct1',
  SF_WH: 'WH1',
  SF_USER: 'svc_user',
  SF_KEY_PATH: '/secrets/sf.p8',
  SF_KEY_PASS: 'unlock',
  GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'load-resolve-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Precedence tests ─────────────────────────────────────────────────────

describe('resolveLoadFromResource — precedence', () => {
  let project: string;
  afterEach(() => project && rmDir(project));

  it('uses resource.load when present (highest precedence)', async () => {
    project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION,
    });
    const result = await resolveLoadFromResource(
      {
        resourceName: 'orders',
        resourceLoad: {
          integration: 'snowflake_prod',
          overrides: { database: 'DOGSLED_RAW', role: 'LOADER_ROLE' },
          defaults: { load_strategy: 'merge' },
        },
        defaultLoad: {
          integration: 'snowflake_prod',
          overrides: { database: 'SHOULD_NOT_USE' },
        },
      },
      ENV,
      project
    );
    expect(result.dest).toBe('snowflake');
    expect((result as { database: string }).database).toBe('DOGSLED_RAW');
  });

  it('falls back to default_load when resource.load is absent', async () => {
    project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION,
    });
    const result = await resolveLoadFromResource(
      {
        resourceName: 'orders',
        defaultLoad: {
          integration: 'snowflake_prod',
          overrides: { database: 'DEFAULT_DB', role: 'DEFAULT_ROLE' },
        },
      },
      ENV,
      project
    );
    expect(result.dest).toBe('snowflake');
    expect((result as { database: string }).database).toBe('DEFAULT_DB');
  });

  it('falls back to --load-file when neither resource.load nor default_load', async () => {
    project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION,
    });
    const loadFilePath = path.join(project, 'load-override.yml');
    fs.writeFileSync(
      loadFilePath,
      `integration: snowflake_prod
overrides:
  database: FILE_DB
  role: FILE_ROLE
defaults:
  load_strategy: append
`
    );
    const result = await resolveLoadFromResource(
      {
        resourceName: 'orders',
        loadFilePath,
      },
      ENV,
      project
    );
    expect(result.dest).toBe('snowflake');
    expect((result as { database: string }).database).toBe('FILE_DB');
  });

  it('throws when no load destination is resolvable', async () => {
    project = makeProject({});
    await expect(
      resolveLoadFromResource({ resourceName: 'orders' }, ENV, project)
    ).rejects.toMatchObject({
      message: expect.stringMatching(/no load destination resolvable/i),
      exitCode: 2,
    });
  });
});

// ── BigQuery ─────────────────────────────────────────────────────────────

describe('resolveLoadFromResource — BigQuery', () => {
  let project: string;
  afterEach(() => project && rmDir(project));

  it('resolves a BigQuery load block', async () => {
    project = makeProject({
      'integrations/bigquery_prod.yml': BIGQUERY_INTEGRATION,
    });
    const result = await resolveLoadFromResource(
      {
        resourceName: 'events',
        resourceLoad: {
          integration: 'bigquery_prod',
          defaults: { load_strategy: 'merge', schema_behavior: 'evolve' },
        },
      },
      ENV,
      project
    );
    expect(result.dest).toBe('bigquery');
    expect((result as { projectId: string }).projectId).toBe('gcp-prod');
    expect((result as { datasetId: string }).datasetId).toBe('raw');
  });
});

// ── Capability rejection ────────────────────────────────────────────────

describe('resolveLoadFromResource — capability rejection', () => {
  let project: string;
  afterEach(() => project && rmDir(project));

  it('rejects API integration as a load destination', async () => {
    project = makeProject({
      'integrations/linear_prod.yml': API_INTEGRATION,
    });
    await expect(
      resolveLoadFromResource(
        {
          resourceName: 'issues',
          resourceLoad: { integration: 'linear_prod' },
        },
        ENV,
        project
      )
    ).rejects.toThrow(/API source/);
  });
});

// ── --load-file edge cases ──────────────────────────────────────────────

describe('resolveLoadFromResource — load file errors', () => {
  it('throws when --load-file path does not exist', async () => {
    await expect(
      resolveLoadFromResource(
        {
          resourceName: 'orders',
          loadFilePath: '/tmp/nonexistent-load-file.yml',
        },
        ENV,
        '/tmp'
      )
    ).rejects.toMatchObject({
      message: expect.stringMatching(/not found/i),
      exitCode: 2,
    });
  });

  it('throws when --load-file has no integration field', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'load-file-'));
    const filePath = path.join(tmp, 'bad.yml');
    fs.writeFileSync(filePath, 'overrides:\n  role: X\n');
    try {
      await expect(
        resolveLoadFromResource({ resourceName: 'orders', loadFilePath: filePath }, ENV, '/tmp')
      ).rejects.toMatchObject({
        message: expect.stringMatching(/integration/i),
        exitCode: 2,
      });
    } finally {
      rmDir(tmp);
    }
  });

  it('rejects --load-file YAML larger than 1 MiB before parsing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'load-file-large-'));
    const filePath = path.join(tmp, 'huge.yml');
    fs.writeFileSync(filePath, 'x'.repeat(1024 * 1024 + 1));
    try {
      await expect(
        resolveLoadFromResource({ resourceName: 'orders', loadFilePath: filePath }, ENV, '/tmp')
      ).rejects.toThrow(/1048576-byte limit/i);
    } finally {
      rmDir(tmp);
    }
  });
});
