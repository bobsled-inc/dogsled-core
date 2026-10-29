import { expect, it } from 'vitest';
import { renderOnboardingHtml } from '../../../src/runtime/onboarding/render.js';
import type { OnboardingSnapshot } from '../../../src/runtime/onboarding/schema.js';
const snapshot: OnboardingSnapshot = {
  state: {
    version: 2,
    inputHash: 'a'.repeat(64),
    datasetVersion: '1',
    steps: [{ id: 'load', label: 'Load raw data', status: 'not_started' }],
  },
  renderedAt: '2026-10-28T12:00:00.000Z',
  sources: [],
  tables: [
    {
      name: 'Products',
      columns: ['name'],
      rows: [{ name: '</script><img src=x onerror=alert(1)>' }],
      totalRows: 1,
    },
  ],
};
it('keeps source markup inert in both readable tables and the embedded snapshot', () => {
  const html = renderOnboardingHtml(snapshot);
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;/script&gt;');
  expect(html).toContain('\\u003c/script>');
  expect(html).not.toMatch(/<script[^>]+src=/);
});
it('rejects oversized previews rather than silently embedding all data', () => {
  expect(() =>
    renderOnboardingHtml({
      ...snapshot,
      tables: [
        { ...snapshot.tables[0]!, rows: Array.from({ length: 501 }, () => ({ name: 'x' })) },
      ],
    })
  ).toThrow();
});

it('explains the empty API-first journey without claiming bundled records', () => {
  const html = renderOnboardingHtml({ ...snapshot, tables: [] });
  expect(html).toContain('Learn Dogsled with TV Night');
  expect(html).toContain('Connect to TVmaze');
  expect(html).toContain('No data fetched yet');
  expect(html).not.toContain('bundled snapshot');
});

it('keeps article passages and supporting excerpts collapsed in static HTML', () => {
  const html = renderOnboardingHtml({
    ...snapshot,
    tables: [
      {
        name: 'Notes',
        columns: ['article_text', 'support_excerpt'],
        rows: [{ article_text: 'Plot revelation', support_excerpt: 'Ending revelation' }],
        totalRows: 1,
      },
    ],
  });
  expect(html).toContain('<details><summary>Show passage (may contain spoilers)</summary>');
  expect(html).not.toContain('<td>Plot revelation</td>');
  expect(html).not.toContain('<td>Ending revelation</td>');
});

it('shows the original question safely and teaches each step with an inspection pause', () => {
  const html = renderOnboardingHtml({
    ...snapshot,
    question: 'I liked The Expanse <script>alert(1)</script>',
  });
  expect(html).toContain('Your original question');
  expect(html).toContain('I liked The Expanse &lt;script&gt;');
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('What you will learn');
  expect(html).toContain('Files to inspect');
  expect(html).toContain('Pause and inspect');
  expect(html).not.toContain('I liked Severance');
});
it('does not present a sample question as the learner question', () => {
  expect(renderOnboardingHtml({ ...snapshot, tables: [] })).toContain('No question saved yet');
});

it('offers chapter orientation, safe files and dependency links', () => {
  const html = renderOnboardingHtml({
    ...snapshot,
    files: [
      {
        path: 'models/shows.yml',
        content: 'name: shows\ndescription: <script>unsafe</script>',
        language: 'yaml',
      },
    ],
    lineage: {
      nodes: [
        {
          id: 'models/shows.yml',
          label: 'shows',
          kind: 'model',
          description: 'TV series',
          available: true,
        },
      ],
      edges: [],
    },
    progress: { current: 'load', reviewed: [], history: [] },
  });
  expect(html).toContain('Where you are');
  expect(html).toContain('Waiting for your inspection');
  expect(html).toContain('Working files');
  expect(html).not.toContain('Examples and solutions');
  expect(html).not.toContain('reference/');
  expect(html).toContain('Model lineage');
  expect(html).not.toContain('<script>unsafe</script>');
});

it('keeps viewing preferences separate from the recommendation question', () => {
  const html = renderOnboardingHtml({
    ...snapshot,
    question: 'What should I watch next?',
    preferences: 'Sci-fi. The Expanse. <script>Political intrigue</script>',
  });
  expect(html).toContain('<blockquote>What should I watch next?</blockquote>');
  expect(html).toContain('<h3>Your viewing preferences</h3>');
  expect(html).toContain('&lt;script&gt;Political intrigue&lt;/script&gt;');
  expect(html).not.toContain('<script>Political intrigue</script>');
});
it('keeps SQL UI exploration optional without popup or server integration', () => {
  const html = renderOnboardingHtml(snapshot);
  expect(html).toContain('For optional SQL exploration');
  expect(html).toContain('The tutorial does not launch or manage it');
  expect(html).not.toContain('sql-popup');
  expect(html).not.toContain('window.open');
  expect(html).not.toContain('localhost:4213');
  expect(html).not.toContain('onboarding explore');
});

it('introduces querying and invites the learner question before building a shortlist', () => {
  const html = renderOnboardingHtml({
    ...snapshot,
    state: {
      ...snapshot.state,
      steps: [{ id: 'query', label: 'Query your data', status: 'not_started' }],
    },
  });
  expect(html).toContain('Dogsled lets you query your models and metrics');
  expect(html).toContain('Choose an example question or ask your own');
  expect(html).toContain('Wait for my question before running a query');
  expect(html).not.toContain('Build or update watch_next using my preferences');
});

it('labels completed results as timestamped snapshots rather than live database results', () => {
  const checkedAt = '2026-10-27T09:00:00.000Z';
  const html = renderOnboardingHtml({
    ...snapshot,
    state: {
      ...snapshot.state,
      steps: [
        {
          id: 'load',
          label: 'Build an ETL pipeline',
          status: 'complete',
          evidence: {
            version: 2,
            step: 'load',
            mode: 'offline',
            inputHash: 'b'.repeat(64),
            at: checkedAt,
            tables: snapshot.tables,
            receipts: [],
          },
        },
      ],
    },
    progress: { current: 'model', reviewed: ['load'], history: [] },
  });
  expect(html).toContain(`Saved check snapshot · ${checkedAt}`);
  expect(html).toContain('These are not live database results');
  expect(html).toContain('Refreshing this page does not rerun checks');
  expect(html).toContain('Later file or database changes do not reset completed chapters');
  expect(html).not.toContain('Inputs changed');
});

it('teaches a pilot before the batch and keeps passage text collapsed', () => {
  const html = renderOnboardingHtml({
    ...snapshot,
    state: {
      ...snapshot.state,
      steps: [{ id: 'transform', label: 'Build an agentic transformation', status: 'not_started' }],
    },
    tables: [
      {
        name: 'Notes',
        columns: ['input_passages'],
        rows: [{ input_passages: 'Spoiler passage' }],
        totalRows: 1,
      },
    ],
  });
  expect(html).toContain('Run one pilot');
  expect(html).toContain('models/assessment_inputs.yml');
  expect(html).toContain('valid assessment, not an execution failure');
  expect(html).not.toContain('<td>Spoiler passage</td>');
  expect(html).toContain('Show passage (may contain spoilers)');
});
