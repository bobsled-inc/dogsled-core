import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadIntegrationFile,
  loadTargetFile,
  resetLegacyWarnings,
  resolveIntegration,
  resolveTarget,
  resolveTargetConfig,
  targetToLoaderConfig,
  validateTargetCapability,
} from '../../src/runtime/target-loader.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const SNOWFLAKE_INTEGRATION_RSA = `
spec_version: "1"
auth_env_vars: [SF_ACCOUNT, SF_KEY_PASS, SF_KEY_PATH, SF_USER, SF_WH]
type: integration
name: snowflake_prod
source_type: snowflake
connection:
  account_identifier_env: SF_ACCOUNT
  warehouse_env: SF_WH
  user_env: SF_USER
  role: READER_ROLE
auth:
  type: rsa_key
  private_key_path_env: SF_KEY_PATH
  private_key_passphrase_env: SF_KEY_PASS
`;

const SNOWFLAKE_INTEGRATION_PAT = `
spec_version: "1"
auth_env_vars: [SF_ACCOUNT, SF_PAT, SF_USER, SF_WH]
type: integration
name: snowflake_prod
source_type: snowflake
connection:
  account_identifier_env: SF_ACCOUNT
  warehouse_env: SF_WH
  user_env: SF_USER
  role: READER_ROLE
auth:
  type: pat
  token_env: SF_PAT
`;

const SNOWFLAKE_INTEGRATION_OAUTH = `
spec_version: "1"
auth_env_vars: [SF_ACCOUNT, SF_OAUTH_CLIENT, SF_OAUTH_SECRET, SF_USER, SF_WH]
type: integration
name: snowflake_prod
source_type: snowflake
connection:
  account_identifier_env: SF_ACCOUNT
  warehouse_env: SF_WH
  user_env: SF_USER
  role: READER_ROLE
auth:
  type: oauth
  client_id_env: SF_OAUTH_CLIENT
  client_secret_env: SF_OAUTH_SECRET
  token_url: https://example.com/oauth/token
`;

const BIGQUERY_INTEGRATION = `
spec_version: "1"
auth_env_vars: [BQ_SA_JSON]
type: integration
name: bigquery_prod
source_type: bigquery
connection:
  project_id: gcp-prod
  dataset: raw
  location: us-central1
auth:
  type: service_account
  credentials_env: BQ_SA_JSON
`;

const API_INTEGRATION = `
spec_version: "1"
type: integration
name: linear_prod
source_type: api
transport:
  base_url: https://api.linear.app
`;

const SNOWFLAKE_TARGET = `
spec_version: "1"
type: target
name: main_warehouse
integration: snowflake_prod
overrides:
  role: LOADER_ROLE
  database: BOBSLED_CORE_RAW
  schema: RAW
defaults:
  load_strategy: merge
`;

const BIGQUERY_TARGET = `
spec_version: "1"
type: target
name: analytics_lake
integration: bigquery_prod
defaults:
  load_strategy: merge
`;

const TARGET_REF_API = `
spec_version: "1"
type: target
name: oops
integration: linear_prod
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-resolve-'));
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

// ── loadTargetFile / resolveTarget ─────────────────────────────────────────

describe('loadTargetFile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-file-'));
  });
  afterEach(() => rmDir(tmp));

  it('parses a valid integration-ref target', async () => {
    const p = path.join(tmp, 't.yml');
    fs.writeFileSync(p, SNOWFLAKE_TARGET);
    const target = await loadTargetFile(p);
    expect(target.name).toBe('main_warehouse');
    expect(target.integration).toBe('snowflake_prod');
    expect(target.overrides?.role).toBe('LOADER_ROLE');
  });

  it('rejects inline target shape (no warehouse, no connection, no auth)', async () => {
    const p = path.join(tmp, 't.yml');
    fs.writeFileSync(
      p,
      `spec_version: "1"
type: target
name: t
warehouse: snowflake
connection: { account_identifier_env: X, warehouse_env: W, database: D }
auth: { type: pat, token_env: T }
`
    );
    await expect(loadTargetFile(p)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('rejects target files larger than 1 MiB before parsing', async () => {
    const p = path.join(tmp, 'huge.yml');
    fs.writeFileSync(p, 'x'.repeat(1024 * 1024 + 1));
    await expect(loadTargetFile(p)).rejects.toThrow(/1048576-byte limit/i);
  });
});

describe('resolveTarget', () => {
  let project: string;
  afterEach(() => project && rmDir(project));

  it('finds targets/<handle>.yml', async () => {
    project = makeProject({ 'targets/main_warehouse.yml': SNOWFLAKE_TARGET });
    const t = await resolveTarget(project, 'main_warehouse');
    expect(t.integration).toBe('snowflake_prod');
  });

  it('rejects path-traversal handles', async () => {
    project = makeProject({});
    await expect(resolveTarget(project, '../escape')).rejects.toThrow(/invalid target handle/i);
  });

  it('rejects target symlinks that escape the project', async () => {
    project = makeProject({});
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'target-outside-'));
    try {
      fs.mkdirSync(path.join(project, 'targets'), { recursive: true });
      const outsideFile = path.join(outside, 'main_warehouse.yml');
      fs.writeFileSync(outsideFile, SNOWFLAKE_TARGET);
      fs.symlinkSync(outsideFile, path.join(project, 'targets', 'main_warehouse.yml'));
      await expect(resolveTarget(project, 'main_warehouse')).rejects.toThrow(
        /symlink target file/i
      );
    } finally {
      rmDir(outside);
    }
  });
});

// ── loadIntegrationFile / resolveIntegration ──────────────────────────────

describe('loadIntegrationFile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'int-file-'));
  });
  afterEach(() => rmDir(tmp));

  it('parses a Snowflake integration with rsa_key auth', async () => {
    const p = path.join(tmp, 'i.yml');
    fs.writeFileSync(p, SNOWFLAKE_INTEGRATION_RSA);
    const i = await loadIntegrationFile(p);
    expect(i.source_type).toBe('snowflake');
    expect(i.name).toBe('snowflake_prod');
  });

  it('parses a BigQuery integration with service_account auth', async () => {
    const p = path.join(tmp, 'i.yml');
    fs.writeFileSync(p, BIGQUERY_INTEGRATION);
    const i = await loadIntegrationFile(p);
    expect(i.source_type).toBe('bigquery');
  });

  it('parses an API integration (capability check happens later)', async () => {
    const p = path.join(tmp, 'i.yml');
    fs.writeFileSync(p, API_INTEGRATION);
    const i = await loadIntegrationFile(p);
    expect(i.source_type).toBe('api');
  });
});

describe('resolveIntegration', () => {
  let project: string;
  afterEach(() => project && rmDir(project));

  it('finds integrations/<handle>.yml', async () => {
    project = makeProject({ 'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_RSA });
    const i = await resolveIntegration(project, 'snowflake_prod');
    expect(i.source_type).toBe('snowflake');
  });

  it('throws when integration not found', async () => {
    project = makeProject({});
    await expect(resolveIntegration(project, 'missing')).rejects.toThrow(/not found/i);
  });

  it('rejects integration symlinks that escape the project', async () => {
    project = makeProject({});
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-outside-'));
    try {
      fs.mkdirSync(path.join(project, 'integrations'), { recursive: true });
      const outsideFile = path.join(outside, 'snowflake_prod.yml');
      fs.writeFileSync(outsideFile, SNOWFLAKE_INTEGRATION_RSA);
      fs.symlinkSync(outsideFile, path.join(project, 'integrations', 'snowflake_prod.yml'));
      await expect(resolveIntegration(project, 'snowflake_prod')).rejects.toThrow(
        /symlink integration file/i
      );
    } finally {
      rmDir(outside);
    }
  });
});

// ── Capability validation ─────────────────────────────────────────────────

describe('validateTargetCapability', () => {
  it('accepts snowflake integration', async () => {
    const project = makeProject({
      'integrations/x.yml': SNOWFLAKE_INTEGRATION_RSA,
      'targets/t.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 't');
      const integration = await loadIntegrationFile(path.join(project, 'integrations/x.yml'));
      expect(() => validateTargetCapability(target, integration)).not.toThrow();
    } finally {
      rmDir(project);
    }
  });

  it('rejects API integration with a clear message', async () => {
    const project = makeProject({
      'integrations/linear_prod.yml': API_INTEGRATION,
      'targets/oops.yml': TARGET_REF_API,
    });
    try {
      const target = await resolveTarget(project, 'oops');
      const integration = await resolveIntegration(project, 'linear_prod');
      expect(() => validateTargetCapability(target, integration)).toThrow(/API source/);
    } finally {
      rmDir(project);
    }
  });
});

// ── targetToLoaderConfig ──────────────────────────────────────────────────

describe('targetToLoaderConfig — Snowflake', () => {
  const env = {
    SF_ACCOUNT: 'acct1',
    SF_WH: 'WH1',
    SF_USER: 'svc_user',
    SF_PAT: 'pat-value',
    SF_KEY_PATH: '/secrets/sf.p8',
    SF_KEY_PASS: 'unlock',
  };

  it('maps rsa_key target → SnowflakeDestConfig with privateKeyPath', async () => {
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_RSA,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      const config = targetToLoaderConfig(target, integration, env);
      expect(config).toMatchObject({
        dest: 'snowflake',
        account: 'acct1',
        username: 'svc_user',
        warehouse: 'WH1',
        database: 'BOBSLED_CORE_RAW',
        targetSchema: 'RAW',
        role: 'LOADER_ROLE',
        privateKeyPath: '/secrets/sf.p8',
        privateKeyPassphrase: 'unlock',
      });
      expect((config as { password?: string }).password).toBeUndefined();
    } finally {
      rmDir(project);
    }
  });

  it('maps oauth target → SnowflakeDestConfig with authenticator + oauth* fields', async () => {
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_OAUTH,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      const config = targetToLoaderConfig(target, integration, {
        ...env,
        SF_OAUTH_CLIENT: 'cid',
        SF_OAUTH_SECRET: 'csecret',
      });
      expect(config).toMatchObject({
        dest: 'snowflake',
        authenticator: 'OAUTH',
        oauthClientId: 'cid',
        oauthClientSecret: 'csecret',
        oauthTokenUrl: 'https://example.com/oauth/token',
      });
      expect((config as { password?: string }).password).toBeUndefined();
      expect((config as { privateKeyPath?: string }).privateKeyPath).toBeUndefined();
    } finally {
      rmDir(project);
    }
  });

  it('maps pat target → SnowflakeDestConfig with password (token)', async () => {
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_PAT,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      const config = targetToLoaderConfig(target, integration, env);
      expect(config).toMatchObject({
        dest: 'snowflake',
        account: 'acct1',
        username: 'svc_user',
        password: 'pat-value',
      });
      expect((config as { privateKeyPath?: string }).privateKeyPath).toBeUndefined();
    } finally {
      rmDir(project);
    }
  });

  it('throws when Snowflake integration omits connection.user_env', async () => {
    const noUser = SNOWFLAKE_INTEGRATION_RSA.replace('  user_env: SF_USER\n', '');
    const project = makeProject({
      'integrations/snowflake_prod.yml': noUser,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      expect(() => targetToLoaderConfig(target, integration, env)).toThrow(/connection\.user_env/);
    } finally {
      rmDir(project);
    }
  });

  it('throws CommandError when a required env var is unset', async () => {
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_RSA,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      expect(() => targetToLoaderConfig(target, integration, { SF_ACCOUNT: 'a' })).toThrow(
        /missing required env vars/
      );
    } finally {
      rmDir(project);
    }
  });
});

describe('targetToLoaderConfig — BigQuery', () => {
  it('maps service_account target → BigQueryDestConfig', async () => {
    const env = { BQ_SA_JSON: '/secrets/sa.json' };
    const project = makeProject({
      'integrations/bigquery_prod.yml': BIGQUERY_INTEGRATION,
      'targets/analytics_lake.yml': BIGQUERY_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'analytics_lake');
      const integration = await resolveIntegration(project, 'bigquery_prod');
      const config = targetToLoaderConfig(target, integration, env);
      expect(config).toMatchObject({
        dest: 'bigquery',
        projectId: 'gcp-prod',
        datasetId: 'raw',
        location: 'us-central1',
        keyFilename: '/secrets/sa.json',
      });
    } finally {
      rmDir(project);
    }
  });
});

// ── resolveTargetConfig (CLI entry point) ─────────────────────────────────

describe('resolveTargetConfig', () => {
  it('resolves via --target flag end-to-end', async () => {
    const env = {
      SF_ACCOUNT: 'a',
      SF_WH: 'w',
      SF_USER: 'u',
      SF_KEY_PATH: '/k',
      SF_KEY_PASS: 'p',
    };
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_RSA,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const result = await resolveTargetConfig({ target: 'main_warehouse' }, env, project);
      expect(result?.dest).toBe('snowflake');
    } finally {
      rmDir(project);
    }
  });

  it('resolves via --target-file flag end-to-end', async () => {
    const env = {
      SF_ACCOUNT: 'a',
      SF_WH: 'w',
      SF_USER: 'u',
      SF_KEY_PATH: '/k',
      SF_KEY_PASS: 'p',
    };
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_RSA,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const result = await resolveTargetConfig(
        { targetFile: path.join(project, 'targets/main_warehouse.yml') },
        env,
        project
      );
      expect(result?.dest).toBe('snowflake');
    } finally {
      rmDir(project);
    }
  });

  it('returns undefined when neither flag is set', async () => {
    const result = await resolveTargetConfig({}, process.env, '/tmp');
    expect(result).toBeUndefined();
  });

  it('rejects more than one of --target / --target-file / --load-integration', async () => {
    await expect(
      resolveTargetConfig({ target: 't', targetFile: '/tmp/x.yml' }, process.env, '/tmp')
    ).rejects.toThrow(/more than one of/i);
    await expect(
      resolveTargetConfig({ target: 't', loadIntegration: 'snowflake' }, process.env, '/tmp')
    ).rejects.toThrow(/more than one of/i);
    await expect(
      resolveTargetConfig(
        { targetFile: '/tmp/x.yml', loadIntegration: 'snowflake' },
        process.env,
        '/tmp'
      )
    ).rejects.toThrow(/more than one of/i);
  });

  it('rejects API integration referenced from a target', async () => {
    const project = makeProject({
      'integrations/linear_prod.yml': API_INTEGRATION,
      'targets/oops.yml': TARGET_REF_API,
    });
    try {
      await expect(resolveTargetConfig({ target: 'oops' }, process.env, project)).rejects.toThrow(
        /API source/
      );
    } finally {
      rmDir(project);
    }
  });
});

// ── New-shape integration resolution ─────────────────────────────────────

const SNOWFLAKE_INTEGRATION_NEW_SHAPE = `
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

const BIGQUERY_INTEGRATION_NEW_SHAPE = `
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

describe('targetToLoaderConfig — new-shape Snowflake', () => {
  const env = {
    SF_ACCOUNT: 'acct1',
    SF_WH: 'WH1',
    SF_USER: 'svc_user',
    SF_KEY_PATH: '/secrets/sf.p8',
    SF_KEY_PASS: 'unlock',
  };

  it('resolves new-shape interpolation to correct config', async () => {
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_NEW_SHAPE,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      const config = targetToLoaderConfig(target, integration, env);
      expect(config).toMatchObject({
        dest: 'snowflake',
        account: 'acct1',
        username: 'svc_user',
        warehouse: 'WH1',
        database: 'BOBSLED_CORE_RAW',
        targetSchema: 'RAW',
        role: 'LOADER_ROLE',
        privateKeyPath: '/secrets/sf.p8',
        privateKeyPassphrase: 'unlock',
      });
    } finally {
      rmDir(project);
    }
  });
});

describe('targetToLoaderConfig — legacy shape deprecation warning', () => {
  it('emits at least one deprecation warning for legacy integration', async () => {
    resetLegacyWarnings();
    const env = {
      SF_ACCOUNT: 'a',
      SF_WH: 'w',
      SF_USER: 'u',
      SF_KEY_PATH: '/k',
      SF_KEY_PASS: 'p',
    };
    const project = makeProject({
      'integrations/snowflake_prod.yml': SNOWFLAKE_INTEGRATION_RSA,
      'targets/main_warehouse.yml': SNOWFLAKE_TARGET,
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const target = await resolveTarget(project, 'main_warehouse');
      const integration = await resolveIntegration(project, 'snowflake_prod');
      targetToLoaderConfig(target, integration, env);
      const deprecationWarnings = stderrSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('[deprecation]')
      );
      // At least one deprecation warning should be emitted
      expect(deprecationWarnings.length).toBeGreaterThan(0);
    } finally {
      rmDir(project);
      stderrSpy.mockRestore();
    }
  });
});

describe('targetToLoaderConfig — BigQuery new-shape with GOOGLE_APPLICATION_CREDENTIALS', () => {
  it('resolves credentials via ${{ env.GOOGLE_APPLICATION_CREDENTIALS }} interpolation', async () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json' };
    const project = makeProject({
      'integrations/bigquery_prod.yml': BIGQUERY_INTEGRATION_NEW_SHAPE,
      'targets/analytics_lake.yml': BIGQUERY_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'analytics_lake');
      const integration = await resolveIntegration(project, 'bigquery_prod');
      const config = targetToLoaderConfig(target, integration, env);
      expect(config).toMatchObject({
        dest: 'bigquery',
        projectId: 'gcp-prod',
        datasetId: 'raw',
        location: 'us-central1',
        keyFilename: '/secrets/sa.json',
      });
    } finally {
      rmDir(project);
    }
  });

  it('accepts JSON payload in credentials env var and passes as credentials object', async () => {
    const saJson = JSON.stringify({
      type: 'service_account',
      project_id: 'gcp-prod',
      private_key_id: 'key-id',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
      client_email: 'sa@gcp-prod.iam.gserviceaccount.com.example.com',
    });
    const env = { GOOGLE_APPLICATION_CREDENTIALS: saJson };
    const project = makeProject({
      'integrations/bigquery_prod.yml': BIGQUERY_INTEGRATION_NEW_SHAPE,
      'targets/analytics_lake.yml': BIGQUERY_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'analytics_lake');
      const integration = await resolveIntegration(project, 'bigquery_prod');
      const config = targetToLoaderConfig(target, integration, env);
      expect(config).toMatchObject({
        dest: 'bigquery',
        credentials: { type: 'service_account', project_id: 'gcp-prod' },
      });
      // keyFilename should be undefined when credentials JSON is used
      expect((config as { keyFilename?: string }).keyFilename).toBeUndefined();
    } finally {
      rmDir(project);
    }
  });

  it('rejects credentials JSON with wrong type field', async () => {
    const badJson = JSON.stringify({ type: 'authorized_user', client_id: '123' });
    const env = { GOOGLE_APPLICATION_CREDENTIALS: badJson };
    const project = makeProject({
      'integrations/bigquery_prod.yml': BIGQUERY_INTEGRATION_NEW_SHAPE,
      'targets/analytics_lake.yml': BIGQUERY_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'analytics_lake');
      const integration = await resolveIntegration(project, 'bigquery_prod');
      expect(() => targetToLoaderConfig(target, integration, env)).toThrow(
        /must have "type": "service_account"/
      );
    } finally {
      rmDir(project);
    }
  });

  it('rejects credentials that look like JSON but are malformed', async () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: '{not valid json!!!' };
    const project = makeProject({
      'integrations/bigquery_prod.yml': BIGQUERY_INTEGRATION_NEW_SHAPE,
      'targets/analytics_lake.yml': BIGQUERY_TARGET,
    });
    try {
      const target = await resolveTarget(project, 'analytics_lake');
      const integration = await resolveIntegration(project, 'bigquery_prod');
      expect(() => targetToLoaderConfig(target, integration, env)).toThrow(
        /looks like JSON but failed to parse/
      );
    } finally {
      rmDir(project);
    }
  });
});

// ── loadTargetFile — V2 resource auto-extract validation ─────────────────────

describe('loadTargetFile — V2 resource load block validation', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-v2-'));
  });
  afterEach(() => rmDir(tmp));

  it('rejects resource YAML with typoed load.integrationn field', async () => {
    const p = path.join(tmp, 'bad_resource.yml');
    fs.writeFileSync(
      p,
      `spec_version: "1"
type: resource
name: test_orders
extract:
  integration: postgres_source
  source:
    table: orders
    schema: public
  replication:
    method: full_refresh
load:
  integrationn: snowflake_warehouse
schema:
  columns:
    id: { type: integer }
`
    );
    await expect(loadTargetFile(p)).rejects.toMatchObject({
      message: expect.stringMatching(/load.*block.*resource/i),
      exitCode: 2,
    });
  });

  it('auto-extracts valid V2 resource load block into target shape', async () => {
    const p = path.join(tmp, 'good_resource.yml');
    fs.writeFileSync(
      p,
      `spec_version: "1"
type: resource
name: test_orders
extract:
  integration: postgres_source
  source:
    table: orders
    schema: public
  replication:
    method: full_refresh
load:
  integration: snowflake_warehouse
  overrides:
    role: LOADER_ROLE
schema:
  columns:
    id: { type: integer }
`
    );
    const target = await loadTargetFile(p);
    expect(target.integration).toBe('snowflake_warehouse');
    expect(target.overrides?.role).toBe('LOADER_ROLE');
  });
});

// ── loadTargetFile ENOENT ────────────────────────────────────────────────────

describe('loadTargetFile — ENOENT handling', () => {
  it('throws CommandError with exit code 2 when target file does not exist', async () => {
    await expect(loadTargetFile('/tmp/nonexistent-target-file.yml')).rejects.toMatchObject({
      message: expect.stringMatching(/not found/i),
      exitCode: 2,
    });
  });
});
