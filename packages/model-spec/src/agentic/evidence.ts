import { z } from 'zod';
import { AgenticEvidenceSchema, AgenticJsonSchema, AgenticJudgmentSchema } from './rows.js';

export type AgenticEvidence = z.infer<typeof AgenticEvidenceSchema>;

/** Keep distinct observations and their original times. Confidence is not combined. */
export function combineAgenticEvidence(
  groups: readonly (readonly AgenticEvidence[] | null)[]
): AgenticEvidence[] | null {
  AgenticJsonSchema.parse(groups);
  const entries = new Map<string, AgenticEvidence>();
  for (const group of groups) {
    if (group === null) continue;
    for (const value of group) {
      const entry = AgenticEvidenceSchema.parse(value);
      const identity = JSON.stringify([
        entry.source,
        entry.reference,
        entry.support_excerpt,
        entry.retrieved_at,
      ]);
      entries.set(identity, entry);
    }
  }
  return AgenticJudgmentSchema.shape._bobsled_evidence.parse(
    entries.size ? [...entries.values()] : null
  );
}
