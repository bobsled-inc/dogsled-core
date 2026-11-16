import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CommandError } from '../../src/commands/common.js';
import { loadAllIntegrations, validateSourceIntegrationRefs } from '../../src/integrations.js';

describe('validateSourceIntegrationRefs', () => {
  it('accepts source registry keys whose handles all match declared integrations', () => {
    const known = new Set(['ecom', 'crm']);
    expect(() =>
      validateSourceIntegrationRefs(
        ['ecom.raw_orders', 'ecom.raw_customers', 'crm.contacts'],
        known
      )
    ).not.toThrow();
  });

  it('skips validation when no integrations are declared (bundle preview / early scaffolding)', () => {
    const known = new Set<string>();
    expect(() =>
      validateSourceIntegrationRefs(['ecom.raw_orders', 'phantom.x'], known)
    ).not.toThrow();
  });

  it('throws CommandError(2) with grouped unknown handles and the declared set', () => {
    const known = new Set(['ecom']);
    expect(() =>
      validateSourceIntegrationRefs(
        ['ecom.raw_orders', 'stripe.charges', 'stripe.refunds', 'hubspot.deals'],
        known
      )
    ).toThrowError(
      expect.objectContaining({
        name: 'CommandError',
        exitCode: 2,
        message: expect.stringContaining('Source files reference undeclared integrations'),
      })
    );

    try {
      validateSourceIntegrationRefs(
        ['ecom.raw_orders', 'stripe.charges', 'stripe.refunds', 'hubspot.deals'],
        known
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('"hubspot" used by deals');
      expect(message).toContain('"stripe" used by charges, refunds');
      expect(message).toContain('Declared integrations: ecom');
    }
  });

  it('produces a CommandError (not a generic Error)', () => {
    const known = new Set(['ecom']);
    try {
      validateSourceIntegrationRefs(['ecom.raw_orders', 'stripe.charges'], known);
      expect.fail('validateSourceIntegrationRefs did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
    }
  });

  it('ignores registry keys with no "." delimiter instead of flagging them as unknown', () => {
    // Malformed keys (missing "handle.source" separator) should not be
    // attributed to an empty-string handle — they originate from an earlier
    // parser path and are surfaced by that layer, not this cross-ref check.
    const known = new Set(['ecom']);
    expect(() =>
      validateSourceIntegrationRefs(['ecom.raw_orders', 'bare_source_name'], known)
    ).not.toThrow();
  });
});

describe('loadAllIntegrations target field adaptation', () => {
  it('resolves env-template target database, schema, and warehouse fields when env vars are set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-model-spec-integrations-'));
    const previous = {
      database: process.env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE,
      schema: process.env.BOBSLED_CORE_MODEL_SPEC_TEST_SCHEMA,
      warehouse: process.env.BOBSLED_CORE_MODEL_SPEC_TEST_WAREHOUSE,
    };
    try {
      process.env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE = 'DEMO_DB';
      process.env.BOBSLED_CORE_MODEL_SPEC_TEST_SCHEMA = 'ANALYTICS';
      process.env.BOBSLED_CORE_MODEL_SPEC_TEST_WAREHOUSE = 'TRANSFORM_WH';
      fs.mkdirSync(path.join(tmpDir, 'integrations'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'integrations', 'snowflake.yml'),
        `spec_version: '1'
auth_env_vars: [BOBSLED_CORE_MODEL_SPEC_TEST_ACCOUNT, BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE, BOBSLED_CORE_MODEL_SPEC_TEST_PAT, BOBSLED_CORE_MODEL_SPEC_TEST_SCHEMA, BOBSLED_CORE_MODEL_SPEC_TEST_USER, BOBSLED_CORE_MODEL_SPEC_TEST_WAREHOUSE]
type: integration
name: snowflake
source_type: snowflake
connection:
  account_identifier: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_ACCOUNT }}
  warehouse: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_WAREHOUSE }}
  user: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_USER }}
  role: DEMO_ROLE
  database: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE }}
  schema: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_SCHEMA }}
auth:
  type: pat
  token: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_PAT }}
`,
        'utf-8'
      );

      const integrations = await loadAllIntegrations(tmpDir, 'integrations');
      const snowflake = integrations.get('snowflake');
      expect(snowflake?.targetDatabase).toBe('DEMO_DB');
      expect(snowflake?.targetSchema).toBe('ANALYTICS');
      expect(snowflake?.targetWarehouse).toBe('TRANSFORM_WH');
    } finally {
      restoreEnv('BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE', previous.database);
      restoreEnv('BOBSLED_CORE_MODEL_SPEC_TEST_SCHEMA', previous.schema);
      restoreEnv('BOBSLED_CORE_MODEL_SPEC_TEST_WAREHOUSE', previous.warehouse);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws CommandError(2) when an explicit env template cannot be resolved', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-model-spec-integrations-'));
    const previous = process.env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE;
    try {
      delete process.env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE;
      fs.mkdirSync(path.join(tmpDir, 'integrations'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'integrations', 'snowflake.yml'),
        `spec_version: '1'
auth_env_vars: [BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE]
type: integration
name: snowflake
source_type: snowflake
connection:
  account_identifier: example
  warehouse: TRANSFORM_WH
  user: demo
  role: DEMO_ROLE
  database: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE }}
  schema: ANALYTICS
auth:
  type: pat
  token: demo
`,
        'utf-8'
      );

      await expect(loadAllIntegrations(tmpDir, 'integrations')).rejects.toThrow(CommandError);
      await expect(loadAllIntegrations(tmpDir, 'integrations')).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE'),
      });
    } finally {
      restoreEnv('BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE', previous);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
