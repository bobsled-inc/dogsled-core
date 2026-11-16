import { describe, expect, it } from 'vitest';

import { PROJECT_GUIDE_MAX_FILE_BYTES } from '../../../src/project-skills/index.js';
import { renderSetupFiles } from '../../../src/setup/render.js';
import { SetupAnswersSchema } from '../../../src/setup/types.js';

describe('renderSetupFiles', () => {
  it('renders the repo config, summary docs, and dashboard state', async () => {
    const answers = SetupAnswersSchema.parse({
      project: {
        repo_name: 'revops-pipelines',
        repo_state: 'new',
      },
      goals: {
        summary: 'Sync Stripe and HubSpot into BigQuery every 4 hours.',
      },
      sources: [
        {
          integration: 'stripe',
          enabled: true,
          schedule: 'every 4h',
        },
        {
          integration: 'hubspot',
          enabled: true,
          schedule: 'every 4h',
        },
      ],
      destination: {
        type: 'bigquery',
        project: 'acme-analytics',
        dataset: 'raw',
        credentials_secret: 'GCP_SERVICE_ACCOUNT_JSON',
      },
      credentials: {
        required_secret_refs: [
          {
            name: 'STRIPE_API_KEY',
            location: 'env_var',
            status: 'configured',
          },
          {
            name: 'HUBSPOT_ACCESS_TOKEN',
            location: 'env_var',
            status: 'missing',
          },
        ],
      },
      status: {
        missing_items: [],
      },
    });

    const files = await renderSetupFiles(answers);
    const bobsledConfig = files.find((file) => file.path === 'bobsled.yml');
    const agentGuide = files.find((file) => file.path === 'AGENTS.md');
    const summary = files.find((file) => file.path === 'bobsled.setup.summary.md');
    const state = files.find((file) => file.path === 'bobsled.dashboard.state.json');
    const starterSkill = files.find((file) => file.path === 'skills/project-overview/SKILL.md');

    expect(bobsledConfig?.content).toContain('destination:');
    expect(bobsledConfig?.content).toContain('project: acme-analytics');
    expect(agentGuide?.content).toContain('bobsled.yml');
    expect(files.some((file) => file.path === 'CLAUDE.md')).toBe(false);
    expect(summary?.content).toContain('Current Goal');
    expect(summary?.content).toContain('HUBSPOT_ACCESS_TOKEN');
    expect(state?.content).toContain('"status": "needs_credentials"');
    expect(starterSkill?.content).toContain('name: project-overview');
    expect(agentGuide?.content).toContain('bobsled skill sync');
    for (const heading of [
      '## About this data',
      '## Queryable data',
      '## Vocabulary',
      '## Conventions',
      '## Caveats',
    ]) {
      expect(agentGuide?.content).toContain(heading);
    }
  });

  it('does not scaffold a guide that its own loader would reject', async () => {
    const answers = SetupAnswersSchema.parse({
      project: {
        repo_name: 'x'.repeat(PROJECT_GUIDE_MAX_FILE_BYTES),
        repo_state: 'new',
      },
      goals: { summary: 'Sync data.' },
      sources: [],
      destination: { type: 'local', format: 'parquet' },
      credentials: { required_secret_refs: [] },
      status: { missing_items: [] },
    });

    await expect(renderSetupFiles(answers)).rejects.toThrow(/Rendered AGENTS\.md .* maximum/);
  });
});
