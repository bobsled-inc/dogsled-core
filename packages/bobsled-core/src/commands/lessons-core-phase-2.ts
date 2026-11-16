import type { Lesson } from './lessons.js';

export const PHASE_2_LESSONS: Lesson[] = [
  // ── Phase 2: API Extract & Load ───────────────────────────────────────────
  {
    id: 'extract-validate',
    title: 'Validate Credentials',
    section: 'Phase 2: API Extract & Load',
    command: 'bobsled extract validate --integration linear',
    env: ['LINEAR_API_KEY'],
    why: 'Validates your API credentials work',
    think: 'Always validate before extracting — fail fast on auth',
  },
  {
    id: 'extract-run-limited',
    title: 'Extract & Load Issues',
    section: 'Phase 2: API Extract & Load',
    command:
      'bobsled extract run --integration linear --resource issues --limit 10 | bobsled load run --dest duckdb --db-path ./dev.duckdb',
    env: ['LINEAR_API_KEY'],
    why: 'Extracts 10 issues and loads them into DuckDB',
    think: 'Pipe extract→load is the core data flow — always limit first',
  },
  {
    id: 'load-count',
    title: 'Verify Row Count',
    section: 'Phase 2: API Extract & Load',
    command: 'bobsled load query --db-path ./dev.duckdb "SELECT count(*) FROM linear__issues"',
    env: ['LINEAR_API_KEY'],
    why: 'Confirms records landed',
    think: 'After every load, verify row count',
  },
  {
    id: 'load-describe',
    title: 'Describe Schema',
    section: 'Phase 2: API Extract & Load',
    command: 'bobsled load query --db-path ./dev.duckdb "DESCRIBE linear__issues"',
    env: ['LINEAR_API_KEY'],
    why: 'Shows the auto-inferred schema',
    think: 'Bobsled Core infers types from the data — DESCRIBE reveals what it chose',
  },
  {
    id: 'extract-stripe',
    title: 'Extract Stripe Charges (Optional)',
    section: 'Phase 2: API Extract & Load',
    command:
      'bobsled extract run --integration stripe --resource charges --limit 5 | bobsled load run --dest duckdb --db-path ./dev.duckdb',
    env: ['STRIPE_SECRET_KEY'],
    why: 'Optional: extract Stripe charges',
    think: "Same pattern, different source — Bobsled Core's integrations are composable",
  },
  {
    id: 'extract-hubspot',
    title: 'Extract HubSpot Contacts (Optional)',
    section: 'Phase 2: API Extract & Load',
    command:
      'bobsled extract run --integration hubspot --resource contacts --limit 5 | bobsled load run --dest duckdb --db-path ./dev.duckdb',
    env: ['HUBSPOT_ACCESS_TOKEN'],
    why: 'Optional: extract HubSpot contacts',
    think: 'Each integration has the same extract→load contract',
  },
  {
    id: 'pipeline-convenience',
    title: 'Pipeline Command',
    section: 'Phase 2: API Extract & Load',
    command:
      'bobsled pipeline --integration linear --resource issues --dest duckdb --db-path ./dev.duckdb --limit 10',
    env: ['LINEAR_API_KEY'],
    why: 'Single command replaces extract|load pipe',
    think: 'pipeline is syntactic sugar — same flow, less typing',
  },
  {
    id: 'pipeline-caution',
    title: 'Pipeline Safety',
    type: 'note',
    section: 'Phase 2: API Extract & Load',
    body: [
      '⚠ pipeline has no hard --limit by default.',
      'Always test with `extract run --limit` first to:',
      '  • Verify the schema looks right',
      '  • Confirm row counts are reasonable',
      '  • Avoid accidentally pulling millions of rows',
      '',
      'Then switch to pipeline for production runs.',
    ],
    why: 'Safety reminder',
    think: 'Convenience commands need guardrails — always test first',
  },
];
