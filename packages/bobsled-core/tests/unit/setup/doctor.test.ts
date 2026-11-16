import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

vi.mock('../../../src/runner/commands/validation.js', () => ({
  validateCliProjectPipelines: vi.fn().mockResolvedValue({
    valid: true,
    errors: [],
    warnings: [],
    secrets: [],
    pipelines: [],
    modelPipelines: [],
    entityGraphPipelines: [],
    project: { config: {}, configPaths: [] },
  }),
}));

import { doctorSetup } from '../../../src/setup/doctor.js';
import { SetupAnswersSchema } from '../../../src/setup/types.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bobsled-setup-doctor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('doctorSetup', () => {
  it('reports blocked setup when credentials are still missing', async () => {
    const dir = createTempDir();
    const answers = SetupAnswersSchema.parse({
      project: {
        repo_name: 'revops-pipelines',
        repo_state: 'new',
      },
      goals: {
        summary: 'Sync Stripe into BigQuery daily.',
      },
      sources: [
        {
          integration: 'stripe',
          enabled: true,
          schedule: 'daily',
        },
      ],
      destination: {
        type: 'bigquery',
        project: 'acme-analytics',
        dataset: 'raw',
      },
      credentials: {
        required_secret_refs: [
          {
            name: 'STRIPE_API_KEY',
            location: 'env_var',
            status: 'missing',
          },
        ],
      },
      status: {
        missing_items: [],
      },
    });

    writeFileSync(path.join(dir, 'bobsled.setup.answers.yml'), stringify(answers), 'utf-8');

    const report = await doctorSetup({ cwd: dir });

    expect(report.status).toBe('blocked');
    expect(report.blockers.some((blocker) => blocker.includes('STRIPE'))).toBe(true);
    expect(report.nextActions).toContain(
      'Add a typed pipeline configuration when the project needs a pipeline.'
    );
  });

  it('reports only the credentials in answers.credentials when it is populated', async () => {
    const dir = createTempDir();
    const answers = SetupAnswersSchema.parse({
      project: {
        repo_name: 'gtm-quick-pipeline',
        repo_state: 'new',
      },
      goals: {
        summary: 'smartlead and pylon to bigquery',
        preset: 'crm-revops',
      },
      sources: [
        {
          integration: 'smartlead',
          enabled: true,
          schedule: 'daily',
        },
        {
          integration: 'pylon',
          enabled: true,
          schedule: 'daily',
        },
      ],
      destination: {
        type: 'bigquery',
        project: 'real-project',
        dataset: 'raw',
      },
      credentials: {
        required_secret_refs: [
          { name: 'SMARTLEAD_API_KEY', location: 'env_var', status: 'missing' },
          { name: 'PYLON_API_TOKEN', location: 'env_var', status: 'missing' },
          { name: 'GCP_SERVICE_ACCOUNT_JSON', location: 'env_var', status: 'missing' },
        ],
      },
      status: {
        setup_phase: 'rendered',
        missing_items: [],
      },
    });

    writeFileSync(path.join(dir, 'bobsled.setup.answers.yml'), stringify(answers), 'utf-8');

    const report = await doctorSetup({ cwd: dir });
    const credCheck = report.checks.find((check) => check.name === 'credentials');

    expect(credCheck?.message).toContain('SMARTLEAD_API_KEY');
    expect(credCheck?.message).toContain('PYLON_API_TOKEN');
    expect(credCheck?.message).toContain('GCP_SERVICE_ACCOUNT_JSON');
    expect(credCheck?.message).not.toContain('HUBSPOT');
    expect(credCheck?.message).not.toContain('STRIPE');
    expect(report.blockers).toHaveLength(3);
  });

  it('falls back to recommended credential refs when required_secret_refs is empty', async () => {
    const dir = createTempDir();
    const answers = SetupAnswersSchema.parse({
      project: {
        repo_name: 'revops-pipelines',
        repo_state: 'new',
      },
      goals: {
        summary: 'Sync Stripe and HubSpot into BigQuery every 4 hours.',
      },
      sources: [],
      destination: {
        type: 'bigquery',
        project: 'acme-analytics',
        dataset: 'raw',
      },
      credentials: {
        // dogsled setup install seeds the starter answers file with an empty list here.
        required_secret_refs: [],
      },
      status: {
        setup_phase: 'gathering-inputs',
        missing_items: [],
      },
    });

    writeFileSync(path.join(dir, 'bobsled.setup.answers.yml'), stringify(answers), 'utf-8');

    const report = await doctorSetup({ cwd: dir });
    const credCheck = report.checks.find((check) => check.name === 'credentials');

    expect(credCheck?.message).toContain('STRIPE_SECRET_KEY');
    expect(credCheck?.message).toContain('HUBSPOT_ACCESS_TOKEN');
    expect(credCheck?.message).toContain('GCP_SERVICE_ACCOUNT_JSON');
    expect(report.blockers).toHaveLength(3);
  });
});
