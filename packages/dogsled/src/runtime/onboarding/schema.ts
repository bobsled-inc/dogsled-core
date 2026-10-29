import { z } from 'zod';

export const StepId = z.enum([
  'connect',
  'load',
  'model',
  'query',
  'federate',
  'transform',
  'resolve',
]);
export type StepId = z.infer<typeof StepId>;
export const Cell = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);
export const PreviewTable = z.object({
  name: z.string().max(120),
  columns: z.array(z.string().max(120)).max(40),
  rows: z.array(z.record(z.string(), Cell)).max(500),
  totalRows: z.number().int().nonnegative(),
});
export const Evidence = z.object({
  mode: z.enum(['offline', 'live', 'recorded']),
  tables: z.array(PreviewTable).max(12),
  receipts: z.array(z.string().max(2000)).max(100),
});
export type Evidence = z.infer<typeof Evidence>;
export const Checkpoint = Evidence.extend({
  version: z.literal(2),
  step: StepId,
  databaseFingerprint: z.string().optional(),
  probeInputHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.string().datetime(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;
export const State = z.object({
  version: z.literal(2),
  inputHash: z.string(),
  datasetVersion: z.string(),
  steps: z.array(
    z.object({
      id: StepId,
      label: z.string(),
      status: z.enum(['not_started', 'running', 'needs_input', 'complete', 'failed', 'stale']),
      evidence: Checkpoint.optional(),
    })
  ),
});
export type OnboardingState = z.infer<typeof State>;
export const Definition = z.object({
  kind: z.string().max(40),
  name: z.string().max(120),
  description: z.string().max(4000),
  fields: z.array(z.string().max(2000)).max(100),
});
export const Question = z.object({
  original: z.string().trim().min(1).max(2000),
  preferences: z.string().trim().min(1).max(2000).optional(),
});
export const Snapshot = z.object({
  progress: z
    .object({
      current: StepId,
      reviewed: z.array(StepId),
      history: z
        .array(
          z.object({ step: StepId, at: z.string(), rows: z.array(z.record(z.string(), Cell)) })
        )
        .max(30),
    })
    .optional(),
  files: z
    .array(
      z.object({ path: z.string().max(500), content: z.string().max(100000), language: z.string() })
    )
    .max(100)
    .optional(),
  lineage: z
    .object({
      nodes: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            kind: z.string(),
            description: z.string(),
            available: z.boolean(),
          })
        )
        .max(300),
      edges: z.array(z.object({ from: z.string(), to: z.string() })).max(500),
    })
    .optional(),
  question: Question.shape.original.optional(),
  preferences: Question.shape.preferences,
  definitions: z.array(Definition).max(100).optional(),
  state: State,
  renderedAt: z.string().datetime(),
  sources: z.array(
    z.object({
      name: z.string(),
      license: z.string(),
      url: z.string().url(),
      rows: z.number().int().nonnegative(),
    })
  ),
  tables: z.array(PreviewTable).max(12),
});
export type OnboardingSnapshot = z.infer<typeof Snapshot>;
export const steps: { id: StepId; label: string }[] = [
  { id: 'connect', label: 'Connect to an API' },
  { id: 'load', label: 'Build an ETL pipeline' },
  { id: 'model', label: 'Build semantic models' },
  { id: 'query', label: 'Query your data' },
  { id: 'federate', label: 'Query across sources' },
  { id: 'transform', label: 'Build an agentic transformation' },
  { id: 'resolve', label: 'Optional: entity resolution' },
];
