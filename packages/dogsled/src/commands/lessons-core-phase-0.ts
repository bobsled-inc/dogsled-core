import type { Lesson } from './lessons.js';

export const PHASE_0_LESSONS: Lesson[] = [
  // ── Phase 0: CLI Surface ──────────────────────────────────────────────────
  {
    id: 'cli-help',
    title: 'Explore the CLI',
    section: 'Phase 0: CLI Surface',
    command: 'dogsled --help',
    why: 'Shows all available commands',
    think: 'The CLI is your control plane — everything starts here',
  },
  {
    id: 'cli-version',
    title: 'Check Version',
    section: 'Phase 0: CLI Surface',
    command: 'dogsled --version',
    why: 'Confirms your installed version',
    think: 'Version mismatches cause subtle bugs — always check',
  },
  {
    id: 'integrations-list',
    title: 'List Integrations',
    section: 'Phase 0: CLI Surface',
    command: 'dogsled integrations list',
    why: 'Shows all pre-built API connectors',
    think: 'Dogsled ships with 80+ ready-to-use integrations',
  },
  {
    id: 'integrations-show',
    title: 'Show Integration',
    section: 'Phase 0: CLI Surface',
    command: 'dogsled integrations show github',
    why: 'Shows what a specific integration can extract',
    think: 'Each integration exposes typed resources you can pull',
  },
  {
    id: 'integrations-show-resource',
    title: 'Show Resource Schema',
    section: 'Phase 0: CLI Surface',
    command: 'dogsled integrations show github repos',
    why: 'Shows the schema for a specific resource',
    think: 'Resources have typed columns — the schema is your contract',
  },
  {
    id: 'examples-list',
    title: 'List Examples',
    section: 'Phase 0: CLI Surface',
    command: 'dogsled examples list',
    why: 'Shows bundled example projects you can scaffold',
    think: 'Examples are complete, runnable projects — not just docs',
  },
  {
    id: 'catalog-note',
    title: 'Reflect: CLI Surface',
    type: 'note',
    section: 'Phase 0: CLI Surface',
    body: [
      'What you just saw: 80+ sources, all composable.',
      'Each integration has resources with typed schemas.',
      "Next: we'll extract real data — with zero credentials.",
    ],
    why: 'Reflect on the CLI surface',
    think: "Dogsled's value is pre-built, typed integrations you compose",
  },
];
