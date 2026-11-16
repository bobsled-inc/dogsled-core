import { describe, expect, it } from 'vitest';

import {
  AGENT_GUIDE_PLACEHOLDER_SENTENCE,
  buildAgentGuide,
  formatDestination,
} from '../../../src/setup/agent-guide.js';
import { renderSetupFiles } from '../../../src/setup/render.js';
import { SetupAnswersSchema } from '../../../src/setup/types.js';

describe('agent guide', () => {
  it('exports the placeholder sentence that the scaffolded guide contains', () => {
    expect(AGENT_GUIDE_PLACEHOLDER_SENTENCE).toBe(
      'Replace this paragraph; agents read it before they interpret a question.'
    );

    const guide = buildAgentGuide(
      'example',
      [{ integration: 'stripe', enabled: true, schedule: 'daily' }],
      { type: 'local', format: 'parquet' }
    );

    expect(guide.startsWith('# example — Agent Guide')).toBe(true);
    expect(guide).toContain('## About this data');
    expect(guide).toContain('Pipeline configuration is optional.');
    expect(guide).toContain('An optional root `bobsled.yml` can hold all pipeline configuration');
    expect(guide).toContain('typed `pipeline_config` fragments can split it across the Project');
    expect(guide).toContain('pass `--project-root /path/to/project`');
    expect(guide).toContain('its path is relative to the Project root and selects one file');
    expect(guide).toContain(AGENT_GUIDE_PLACEHOLDER_SENTENCE);
    expect(guide).toContain('- `stripe` — schedule: `daily`');
    expect(guide).toContain('- local (parquet)');
  });

  it('renders AGENTS.md from the same builder', async () => {
    const answers = SetupAnswersSchema.parse({
      project: { repo_name: 'example', repo_state: 'new' },
      goals: { summary: 'Sync data.' },
      sources: [],
      destination: { type: 'local', format: 'parquet' },
      credentials: { required_secret_refs: [] },
      status: { missing_items: [] },
    });

    const files = await renderSetupFiles(answers);
    const agentGuide = files.find((file) => file.path === 'AGENTS.md');

    expect(agentGuide?.content).toContain(AGENT_GUIDE_PLACEHOLDER_SENTENCE);
  });

  it.each([
    ['clickhouse', { type: 'clickhouse', host: 'ch.example.com', database: 'analytics' }],
    ['turbopuffer', { type: 'turbopuffer', region: 'gcp-us-central1' }],
  ] as const)('formats the %s destination in the generated guide', (_name, destination) => {
    expect(formatDestination(destination)).toContain(destination.type);
  });
});
