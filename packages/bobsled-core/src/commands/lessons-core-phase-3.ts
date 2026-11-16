import type { Lesson } from './lessons.js';

export const PHASE_3_LESSONS: Lesson[] = [
  // ── Phase 3: Incremental Load & State ─────────────────────────────────────
  {
    id: 'incremental-first',
    title: 'First Merge Load',
    section: 'Phase 3: Incremental Load & State',
    cwd: 'lab',
    command:
      'dogsled extract run --integration linear --resource issues --limit 25 | dogsled load run --dest duckdb --db-path ./dev.duckdb --strategy merge --primary-key id',
    env: ['LINEAR_API_KEY'],
    why: 'First merge load: 25 records',
    think: 'Merge uses the primary key to upsert — new rows insert, existing rows update',
  },
  {
    id: 'incremental-count-before',
    title: 'Baseline Count',
    section: 'Phase 3: Incremental Load & State',
    cwd: 'lab',
    command:
      'dogsled load query --db-path ./dev.duckdb "SELECT count(*) as issue_count FROM linear__issues"',
    env: ['LINEAR_API_KEY'],
    why: 'Baseline count before second load',
    think: 'Always measure before and after to prove dedup',
  },
  {
    id: 'incremental-second',
    title: 'Second Merge Load (Overlapping)',
    section: 'Phase 3: Incremental Load & State',
    cwd: 'lab',
    command:
      'dogsled extract run --integration linear --resource issues --limit 50 | dogsled load run --dest duckdb --db-path ./dev.duckdb --strategy merge --primary-key id',
    env: ['LINEAR_API_KEY'],
    why: 'Second load: 50 records (overlapping with first)',
    think: 'Overlap is intentional — merge will deduplicate by primary key',
  },
  {
    id: 'incremental-count-after',
    title: 'Verify Deduplication',
    section: 'Phase 3: Incremental Load & State',
    cwd: 'lab',
    command:
      'dogsled load query --db-path ./dev.duckdb "SELECT count(*) as issue_count FROM linear__issues"',
    env: ['LINEAR_API_KEY'],
    why: 'Shows deduplication: count < 75 proves merge worked',
    think: 'If you see 50 (not 75), merge correctly upserted the overlapping 25',
  },
];
