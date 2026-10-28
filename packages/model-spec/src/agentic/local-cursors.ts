import { updateLocalState } from '../compiler/state.js';
import { z } from 'zod';
import { digestAgenticState } from './state.js';
import { AgenticCursorKeySchema, CursorRecordSchema, updateCursorRecord } from './cursor.js';
import type { AgenticCursorStore, AgenticCursorKey, AgenticCursorValues } from './cursor.js';
const Index = z
  .record(z.string().regex(/^[a-f0-9]{64}$/), CursorRecordSchema)
  .refine((value) => Object.keys(value).length <= 10000);
/** Shared local state is the local equivalent of the warehouse cursor table. */
export function createLocalAgenticCursorStore(project: string): AgenticCursorStore {
  const mutate = (
    key: AgenticCursorKey,
    signature: string,
    runId: string,
    values?: AgenticCursorValues,
    previousRunId?: string
  ) => {
    let result: AgenticCursorValues = {};
    updateLocalState(project, (state) => {
      const index = Index.parse(state.agentic_cursors ?? {});
      const hash = digestAgenticState(AgenticCursorKeySchema.parse(key));
      const record = updateCursorRecord(
        index[hash] ?? null,
        signature,
        runId,
        values,
        previousRunId
      );
      result = record.values;
      return { ...state, agentic_cursors: Index.parse({ ...index, [hash]: record }) };
    });
    return result;
  };
  return {
    supersede: async (key, signature, previousRunId, runId) =>
      mutate(key, signature, runId, undefined, previousRunId),
    async begin(key, signature, runId) {
      return mutate(key, signature, runId);
    },
    async commit(key, signature, runId, values) {
      mutate(key, signature, runId, values);
    },
  };
}
