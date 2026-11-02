import { steps } from '../src/runtime/onboarding/tutorials/tv-night/steps.js';
import { lessons } from '../src/runtime/onboarding/tutorials/tv-night/lessons.js';
import {
  Snapshot,
  type OnboardingSnapshot,
  type StepId,
} from '../src/runtime/onboarding/schema.js';

type Table = OnboardingSnapshot['tables'][number];
const at = '2026-10-29T12:00:00.000Z';
const inputHash = '0'.repeat(64);
const checkpoint = (step: StepId, tables: Table[]) => ({
  version: 2 as const,
  step,
  mode: 'offline' as const,
  inputHash,
  at,
  tables,
  receipts: ['Synthetic visual-review fixture. No service was contacted.'],
});

function populated(): OnboardingSnapshot {
  const shows: Table = {
    name: 'Shows',
    columns: ['id', 'name', 'status', 'runtime', 'genres', 'episode_count'],
    totalRows: 120,
    rows: Array.from({ length: 36 }, (_, index) => ({
      id: 1001 + index,
      name: ['Orbital Assembly', 'Harbour Files', 'Paper Satellites'][index % 3] + ` ${index + 1}`,
      status: index % 2 ? 'Ended' : 'Running',
      runtime: index === 5 ? null : 30 + index,
      genres: index % 2 ? 'Crime, Drama' : 'Science-Fiction, Mystery',
      episode_count: 3,
    })),
  };
  const episodes: Table = {
    name: 'Episodes',
    columns: ['id', 'show_id', 'name', 'season', 'number', 'runtime'],
    totalRows: 360,
    rows: Array.from({ length: 60 }, (_, index) => ({
      id: 2001 + index,
      show_id: 1001 + Math.floor(index / 3),
      name: `Episode ${index + 1}`,
      season: 1,
      number: (index % 3) + 1,
      runtime: index === 5 ? null : 42,
    })),
  };
  const shortlist: Table = {
    name: 'Your shortlist',
    columns: ['id', 'name', 'episode_count', 'reason'],
    totalRows: 5,
    rows: shows.rows.slice(0, 5).map((row) => ({
      id: row.id!,
      name: row.name!,
      episode_count: row.episode_count!,
      reason: 'Matches the saved episode-length rule.',
    })),
  };
  const articles: Table = {
    name: 'Article context',
    columns: ['show_id', 'title', 'article_text', 'revision'],
    totalRows: 5,
    rows: shortlist.rows.map((row) => ({
      show_id: row.id!,
      title: row.name!,
      article_text:
        'Fictional article passage for visual inspection. This is synthetic text, not evidence about a real programme.',
      revision: 10,
    })),
  };
  const recommendations: Table = {
    name: 'Recommendations',
    columns: ['id', 'name', 'fit', 'reason', 'support_excerpt'],
    totalRows: 5,
    rows: shortlist.rows.map((row, index) => ({
      id: row.id!,
      name: row.name!,
      fit: index === 4 ? 'unknown' : 'possible',
      reason:
        index === 4
          ? 'More evidence is needed.'
          : 'Synthetic assessment for reviewing the interface.',
      support_excerpt: 'Fictional supporting passage; expand to inspect the disclosure.',
    })),
  };
  const matches: Table = {
    name: 'Watchlist matches',
    columns: ['title', 'show_id', 'review_status'],
    totalRows: 3,
    rows: [
      { title: 'Orbital Assembly', show_id: 1001, review_status: 'accepted' },
      { title: 'Harbour', show_id: null, review_status: 'unresolved' },
      { title: 'Paper Satellites', show_id: 1003, review_status: 'accepted' },
    ],
  };
  const perStep: Record<StepId, Table[]> = {
    connect: [{ ...shows, name: 'API response', rows: shows.rows.slice(0, 1), totalRows: 1 }],
    load: [shows, episodes],
    model: [{ ...shows, name: 'Modelled shows' }],
    query: [shortlist],
    federate: [articles],
    transform: [recommendations],
    resolve: [matches],
  };
  const graphFiles = [
    'integrations/tvmaze.yml',
    'resources/tvmaze/shows.yml',
    'sources/shows.yml',
    'sources/episodes.yml',
    'models/shows.yml',
    'models/episodes.yml',
    'models/watch_next.yml',
    'models/recommendations.yml',
  ];
  const files = [
    ...new Set([...graphFiles, ...Object.values(lessons).flatMap((lesson) => lesson.files)]),
  ].map((path, index) => ({
    path,
    language: path.endsWith('.sql') ? 'sql' : 'yaml',
    content: path.endsWith('.sql')
      ? 'SELECT id, name FROM watch_next LIMIT 5;'
      : `# Synthetic visual-review definition.\nname: ${path.split('/').at(-1)!.replace('.yml', '')}\ndescription: Example definition ${index + 1}\n`,
  }));
  return {
    renderedAt: at,
    question: 'What should I watch next?',
    preferences: 'A short science-fiction series with an ensemble cast.',
    state: {
      version: 2,
      inputHash,
      datasetVersion: 'visual-review',
      steps: steps.map((step) => ({
        ...step,
        status: 'complete',
        evidence: checkpoint(step.id, perStep[step.id]),
      })),
    },
    sources: [
      {
        name: 'Fictional TV catalog',
        url: 'https://example.com/tv-night',
        license: 'Synthetic visual-review data',
        rows: 120,
      },
    ],
    tables: Object.values(perStep).flat(),
    files,
    definitions: [
      {
        kind: 'source',
        name: 'shows',
        description: 'One row per fictional TV series.',
        fields: ['id: Synthetic show identifier', 'runtime: Minutes; null means unknown'],
      },
      {
        kind: 'model',
        name: 'watch_next',
        description: 'A reusable shortlist rule.',
        fields: ['source: shows', 'episode_count: Fetched episodes only'],
      },
    ],
    lineage: {
      nodes: files
        .filter((file) => graphFiles.includes(file.path))
        .map((file) => ({
          id: file.path,
          label: file.path.split('/').at(-1)!.replace('.yml', ''),
          kind: file.path.split('/')[0]!,
          description: 'Synthetic definition for visual review.',
          available: true,
        })),
      edges: [
        { from: 'integrations/tvmaze.yml', to: 'resources/tvmaze/shows.yml' },
        { from: 'resources/tvmaze/shows.yml', to: 'sources/shows.yml' },
        { from: 'sources/shows.yml', to: 'models/shows.yml' },
        { from: 'sources/episodes.yml', to: 'models/episodes.yml' },
        { from: 'models/shows.yml', to: 'models/watch_next.yml' },
        { from: 'models/watch_next.yml', to: 'models/recommendations.yml' },
      ],
    },
    progress: {
      current: 'load',
      reviewed: ['connect'],
      history: [
        { step: 'query', at, rows: shortlist.rows },
        { step: 'transform', at, rows: recommendations.rows },
      ],
    },
  };
}

export interface PreviewScenario {
  id: string;
  label: string;
  description: string;
  chapter: StepId;
  snapshot: OnboardingSnapshot;
}
export function previewScenarios(): PreviewScenario[] {
  const make = (
    id: string,
    label: string,
    description: string,
    chapter: StepId,
    adjust: (snapshot: OnboardingSnapshot) => void
  ): PreviewScenario => {
    const snapshot = populated();
    adjust(snapshot);
    snapshot.progress!.current = chapter;
    snapshot.tables = snapshot.state.steps.flatMap((step) => step.evidence?.tables ?? []);
    return { id, label, description, chapter, snapshot: Snapshot.parse(snapshot) };
  };
  return [
    make('start', 'Not started', 'An empty project before any work has run.', 'connect', (s) => {
      s.state.steps = steps.map((step) => ({ ...step, status: 'not_started' }));
      s.files = [];
      s.lineage = { nodes: [], edges: [] };
      s.definitions = [];
      s.sources = [];
      s.progress!.reviewed = [];
      s.progress!.history = [];
      delete s.question;
      delete s.preferences;
    }),
    make(
      'populated',
      'Populated results',
      'Saved results for every chapter. Explore tables, files, graph nodes and passage disclosures.',
      'load',
      () => {}
    ),
    make('empty', 'Empty result', 'A successful check with zero matching rows.', 'query', (s) => {
      s.state.steps.find((step) => step.id === 'query')!.evidence!.tables = [
        { name: 'Your shortlist', columns: ['id', 'name', 'reason'], rows: [], totalRows: 0 },
      ];
      s.progress!.history = [];
    }),
    make(
      'reviewed',
      'Reviewed',
      'All chapters reviewed, with saved answer history.',
      'transform',
      (s) => {
        s.progress!.reviewed = steps.map((step) => step.id);
      }
    ),
    make(
      'failed',
      'Failed check',
      'A failed check with earlier saved results still available for inspection.',
      'federate',
      (s) => {
        s.state.steps.find((step) => step.id === 'federate')!.status = 'failed';
      }
    ),
    make(
      'attention',
      'Needs attention',
      'ETL running, a query waiting for input, and a transformation requiring another check.',
      'query',
      (s) => {
        s.state.steps.find((step) => step.id === 'load')!.status = 'running';
        s.state.steps.find((step) => step.id === 'query')!.status = 'needs_input';
        s.state.steps.find((step) => step.id === 'transform')!.status = 'stale';
      }
    ),
    make(
      'long',
      'Long content',
      'Long titles, explanations and source passages. Check clipping, wrapping and row inspection.',
      'load',
      (s) => {
        for (const step of s.state.steps) {
          for (const table of step.evidence?.tables ?? []) {
            for (const row of table.rows) {
              if (typeof row.name === 'string') {
                row.name +=
                  ' — The extraordinary chronicles of a very distant orbital research station';
              }
              if (typeof row.reason === 'string') {
                row.reason = 'A deliberately long explanation for visual review. '.repeat(18);
              }
              if (typeof row.article_text === 'string') {
                row.article_text =
                  'A synthetic passage that should remain collapsed until opened. '.repeat(60);
              }
            }
          }
        }
        s.preferences =
          'A long-form viewing preference used to check readable line lengths. '.repeat(12);
      }
    ),
    make(
      'graph',
      'Larger graph',
      'Forty definitions across five layers. Open Model lineage to inspect scrolling and node-to-file navigation.',
      'model',
      (s) => {
        const nodes = Array.from({ length: 40 }, (_, index) => ({
          id: `models/layer_${Math.floor(index / 8) + 1}_model_${index + 1}.yml`,
          label: `Model ${index + 1}`,
          kind: 'model',
          description: 'Synthetic graph definition.',
          available: index !== 39,
        }));
        s.files = nodes
          .filter((n) => n.available)
          .map((n) => ({
            path: n.id,
            language: 'yaml',
            content: `# Synthetic visual-review definition.\nname: model_${n.label.split(' ')[1]}\n`,
          }));
        s.lineage = {
          nodes,
          edges: nodes
            .filter((_, i) => i >= 8)
            .flatMap((node, index) => [
              { from: nodes[index]!.id, to: node.id },
              ...(index % 3 === 0
                ? [{ from: nodes[Math.floor(index / 8) * 8 + ((index + 1) % 8)]!.id, to: node.id }]
                : []),
            ]),
        };
      }
    ),
  ];
}
