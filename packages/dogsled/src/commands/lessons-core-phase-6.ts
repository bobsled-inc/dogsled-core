import type { Lesson } from './lessons.js';

export const PHASE_6_LESSONS: Lesson[] = [
  // ── Phase 6: Verified Queries & Lazy/Live Querying ────────────────────────
  {
    id: 'vq-intro-note',
    title: 'Verified Queries',
    type: 'note',
    section: 'Phase 6: Verified Queries',
    body: [
      'Verified Queries (VQs) are pre-approved SQL templates.',
      '',
      'They pair:',
      "  • A natural-language intent ('monthly revenue')",
      '  • With a tested SQL query',
      '  • And optional parameters',
      '',
      'VQs are safe for agents and dashboards — known-good SQL.',
    ],
    why: 'Introduces verified queries',
    think: 'VQs give you repeatable, tested analytics',
  },
  {
    id: 'vq-list',
    title: 'List Verified Queries',
    section: 'Phase 6: Verified Queries',
    cwd: 'shop',
    command: 'dogsled vq list',
    why: 'Lists available verified queries',
    think: "VQs are discoverable — list shows what's available",
  },
  {
    id: 'vq-run',
    title: 'Run a Verified Query',
    section: 'Phase 6: Verified Queries',
    cwd: 'shop',
    command: 'dogsled vq run revenue_by_month',
    why: 'Executes a verified query',
    think: 'vq run executes the pre-tested SQL and returns results',
  },
  {
    id: 'vq-run-param',
    title: 'Run with Parameters',
    section: 'Phase 6: Verified Queries',
    cwd: 'shop',
    command: 'dogsled vq run revenue_by_month --param month=2026-04',
    why: 'Runs a VQ with a parameter',
    think: 'Parameters let you reuse one query for different time ranges',
  },
];
