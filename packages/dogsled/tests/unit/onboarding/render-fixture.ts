import { steps, type OnboardingSnapshot } from '../../../src/runtime/onboarding/schema.js';

export function renderFixture(): OnboardingSnapshot {
  const tables = [
    {
      name: 'Shows',
      columns: ['id', 'name', 'runtime', 'article_text'],
      totalRows: 200,
      rows: Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        name: `Series ${i + 1}`,
        runtime: i ? 40 : null,
        article_text: `Passage ${i + 1}`,
      })),
    },
    {
      name: 'Episodes',
      columns: ['show_id', 'title'],
      totalRows: 1,
      rows: [{ show_id: 1, title: 'Pilot' }],
    },
  ];
  const evidence = {
    version: 2 as const,
    step: 'load' as const,
    mode: 'live' as const,
    inputHash: 'a'.repeat(64),
    at: '2026-10-28T12:00:00.000Z',
    receipts: ['Checked two local tables.'],
    tables,
  };
  return {
    renderedAt: '2026-10-28T12:00:00.000Z',
    question: 'What should I watch next?',
    preferences: 'Short episodes',
    state: {
      version: 2,
      inputHash: 'a'.repeat(64),
      datasetVersion: '1',
      steps: steps.map((step) => ({
        ...step,
        status: step.id === 'load' ? 'complete' : 'not_started',
        ...(step.id === 'load' ? { evidence } : {}),
      })),
    },
    sources: [
      {
        name: 'Example catalog',
        url: 'https://example.com',
        license: 'Synthetic fixture',
        rows: 200,
      },
    ],
    tables,
    files: [
      {
        path: 'sources/shows.yml',
        content: 'name: shows\ndescription: <script>inert</script>',
        language: 'yaml',
      },
    ],
    lineage: {
      nodes: [
        {
          id: 'sources/shows.yml',
          label: 'shows',
          kind: 'source',
          description: 'Series',
          available: true,
        },
      ],
      edges: [],
    },
    progress: { current: 'load', reviewed: [], history: [] },
  };
}
