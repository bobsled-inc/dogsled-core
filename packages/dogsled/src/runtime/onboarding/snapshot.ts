import YAML from 'yaml';
import { readJournal, checkpointId } from './journal.js';
import { projectWorkspace } from './workspace.js';
import { z } from 'zod';
import { Definition, Question, Snapshot, type OnboardingSnapshot } from './schema.js';
import { inspectOnboarding } from './state.js';
import { readBounded, inputFiles } from './files.js';
const SemanticColumn = z.object({
  name: z.string(),
  expr: z.string().optional(),
  description: z.string().optional(),
  ai_context: z.unknown().optional(),
});
const Manifest = z.object({ sources: Snapshot.shape.sources });
export async function buildOnboardingSnapshot(root: string): Promise<OnboardingSnapshot> {
  let question: string | undefined;
  let preferences: string | undefined;
  try {
    const saved = Question.parse(
      JSON.parse(await readBounded(root, 'data/tv-night/question.json'))
    );
    question = saved.original;
    preferences = saved.preferences;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const state = await inspectOnboarding(root);
  const journal = await readJournal(root);
  const reviewed = state.steps
    .filter(
      (s) =>
        s.status === 'complete' && s.evidence && journal.reviews[s.id] === checkpointId(s.evidence)
    )
    .map((s) => s.id);
  const progress = {
    current:
      state.steps.find((s) => s.id !== 'resolve' && !reviewed.includes(s.id))?.id ?? 'transform',
    reviewed,
    history: journal.history,
  };
  const manifest = Manifest.parse(
    JSON.parse(await readBounded(root, 'data/tv-night/manifest.json'))
  );
  const tables = state.steps.flatMap((s) =>
    s.status === 'complete' ? (s.evidence?.tables ?? []) : []
  );
  const definitions = [];
  const workspace = await projectWorkspace(root);
  for (const file of await inputFiles(root)) {
    if (
      !/^(sources|models|metrics|relationships)\/.*\.ya?ml$/.test(file) ||
      !workspace.files.some((f) => f.path === file)
    ) {
      continue;
    }
    const value = z
      .object({
        name: z.string(),
        description: z.string().optional(),
        columns: z.array(SemanticColumn).optional(),
        schema: z.object({ columns: z.array(SemanticColumn).optional() }).optional(),
        ai_context: z.unknown().optional(),
        expr: z.string().optional(),
        expression: z.string().optional(),
        left_model: z.string().optional(),
        right_model: z.string().optional(),
        join_type: z.string().optional(),
        relationship_type: z.string().optional(),
        join_columns: z.array(z.object({ left: z.string(), right: z.string() })).optional(),
      })
      .parse(
        YAML.parse(workspace.files.find((f) => f.path === file)?.content ?? '{}', {
          maxAliasCount: 0,
        })
      );
    definitions.push(
      Definition.parse({
        kind: file.split('/')[0],
        name: value.name,
        description: [
          value.description,
          value.ai_context ? JSON.stringify(value.ai_context) : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        fields:
          (value.columns ?? value.schema?.columns)?.map(
            (c) =>
              `${c.name}${c.expr ? `: ${c.expr}` : ''}${c.description ? ` — ${c.description}` : ''}${c.ai_context ? ` · ${JSON.stringify(c.ai_context)}` : ''}`
          ) ??
          (value.expression
            ? [value.expression]
            : value.expr
              ? [value.expr]
              : value.left_model
                ? [
                    `${value.left_model} → ${value.right_model}`,
                    `${value.join_type} / ${value.relationship_type}`,
                    ...(value.join_columns ?? []).map((c) => `${c.left} = ${c.right}`),
                  ]
                : []),
      })
    );
  }
  return Snapshot.parse({
    question,
    preferences,
    progress,
    ...workspace,
    definitions,
    state,
    sources: manifest.sources.map((source) => ({
      ...source,
      rows:
        source.name === 'TVmaze'
          ? (state.steps
              .find((s) => s.id === 'load' && s.status === 'complete')
              ?.evidence?.tables.reduce((sum, table) => sum + table.totalRows, 0) ?? 0)
          : source.name === 'Wikipedia'
            ? (state.steps.find((s) => s.id === 'federate' && s.status === 'complete')?.evidence
                ?.tables[0]?.totalRows ?? 0)
            : source.rows,
    })),
    tables: tables.slice(0, 12),
    renderedAt: new Date().toISOString(),
  });
}
