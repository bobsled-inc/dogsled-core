import { buildAgenticStepAssignments } from '../../src/agentic/plan-work.js';
import { resolveAgenticModel } from '../../src/agentic/resolve.js';
import { executeAgenticRun } from '../../src/agentic/run.js';
import type {
  AgenticCheckpointCommand,
  AgenticRunKey,
  AgenticRunSnapshot,
  AgenticStateStore,
} from '../../src/agentic/state.js';
import type { AgenticPublisher } from '../../src/agentic/publication.js';
import type { AgenticCursorStore } from '../../src/agentic/cursor.js';
import { updateCursorRecord, type CursorRecord } from '../../src/agentic/cursor.js';
import { MemoryStateStore, runFixture } from '../unit/agentic/state-fixture.js';

export interface AgenticStoreScenario {
  key: AgenticRunKey;
  initial: AgenticRunSnapshot;
  commands: AgenticCheckpointCommand[];
}

/** Records what a store receives, so replays use exactly what a coordinator sends. */
class RecordingStore extends MemoryStateStore {
  initial: AgenticRunSnapshot | undefined;
  key: AgenticRunKey | undefined;
  commands: AgenticCheckpointCommand[] = [];
  override async acquire(key: AgenticRunKey) {
    const session = await super.acquire(key);
    this.key = key;
    return {
      ...session,
      create: async (snapshot: AgenticRunSnapshot) => {
        this.initial = structuredClone(snapshot);
        return session.create(snapshot);
      },
      checkpoint: async (command: AgenticCheckpointCommand) => {
        this.commands.push(structuredClone(command));
        return session.checkpoint(command);
      },
    };
  }
}

/**
 * A recorded command, as a coordinator would send it now. A later step's assignments embed
 * when earlier attempts finished, which differs on every replay.
 */
export function currentCommand(
  snapshot: AgenticRunSnapshot,
  command: AgenticCheckpointCommand
): AgenticCheckpointCommand {
  return command.type === 'append_step' &&
    !snapshot.sealed_steps?.some((step) => step.id === command.step_id)
    ? {
        ...command,
        assignments: buildAgenticStepAssignments(snapshot, snapshot.sealed_steps!.length),
      }
    : command;
}

const publisher: AgenticPublisher = {
  preflight: async () => {},
  claim: async () => ({ version: 0, fence: 'fence' }),
  prepare: async (_context, identity) => ({
    identity,
    expected_version: 0,
    stage: `stage_${identity.operation_id}`,
  }),
  inspect: async () => null,
  commit: async (intent) => ({ intent, committed_version: 1 }),
  close: async () => {},
};

function memoryCursors(): AgenticCursorStore {
  const records = new Map<string, CursorRecord>();
  const update: AgenticCursorStore['commit'] = async (key, signature, runId, values) => {
    const name = JSON.stringify(key);
    const record = updateCursorRecord(records.get(name) ?? null, signature, runId, values);
    records.set(name, record);
  };
  return {
    begin: async (key, signature, runId) => {
      const name = JSON.stringify(key);
      const record = updateCursorRecord(records.get(name) ?? null, signature, runId);
      records.set(name, record);
      return record.values;
    },
    commit: update,
  };
}

async function recorded(
  id: string,
  host: Parameters<typeof executeAgenticRun>[0],
  context: Parameters<typeof executeAgenticRun>[1],
  extra: Partial<Parameters<typeof executeAgenticRun>[2]> = {}
): Promise<AgenticStoreScenario> {
  const stateStore = new RecordingStore();
  await executeAgenticRun(host, context, {
    projectDirectory: '/unused',
    stateStore: stateStore as AgenticStateStore,
    run: { id, mode: 'start' },
    ...extra,
  });
  return { key: stateStore.key!, initial: stateStore.initial!, commands: stateStore.commands };
}

/** A single map step: `seal_work` carries every assignment. Each row has a non-key column
 * that nothing else in the snapshot repeats. */
export function mapScenario(assignments = 3): Promise<AgenticStoreScenario> {
  const fixture = runFixture(assignments);
  fixture.host.inputs.undecided_pairs = [
    { name: 'pair_id', type: 'string', nullable: false },
    { name: 'evidence', type: 'string', nullable: false },
  ];
  fixture.host.prepare = async () =>
    Array.from({ length: assignments }, (_, index) => ({
      pair_id: `p${index}`,
      evidence: `original-evidence-${index}`,
    }));
  return recorded('conformance-map', fixture.host, fixture.context());
}

/**
 * Two steps over an incremental source, published and confirmed. Covers `seal_work` with
 * frozen inputs and cursor values, `append_step`, attempts, `complete`, both publication
 * commands and `confirm_cursors`.
 */
export async function planScenario(): Promise<AgenticStoreScenario> {
  const fixture = runFixture(4);
  fixture.model.limits = {};
  const first = fixture.model.plan.steps[0]!;
  fixture.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
  fixture.host.inputs.undecided_pairs = [
    { name: 'pair_id', type: 'string', nullable: false },
    { name: 'updated_at', type: 'integer', nullable: false },
  ];
  first.columns = [
    { name: 'pair_id', type: 'string', nullable: false },
    { name: 'assessment', type: 'string', nullable: false },
  ];
  fixture.model.plan.steps.push({
    id: 'review',
    source: { ref: first.id },
    reduce: { over: first.id, group_by: ['pair_id'] },
    execution: { mode: 'llm_call' },
    instructions: 'Review each assessment.',
    columns: first.columns,
  });
  fixture.model.output.from = 'review';
  fixture.host.prepare = async () =>
    Array.from({ length: 4 }, (_, index) => ({ pair_id: `p${index}`, updated_at: index + 1 }));
  fixture.host.executeAgent = async ({ assignment, budget }) => {
    const usage = {
      status: 'measured' as const,
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    };
    await budget.settle(await budget.reserve(100), usage);
    return {
      contract_version: 2 as const,
      attempt_id: assignment.attempt_id,
      status: 'succeeded' as const,
      usage,
      // Non-ASCII text checks that content survives every store unchanged.
      rows: assignment.processed_keys.map(({ pair_id }) => ({
        pair_id: String(pair_id),
        assessment: `Résumé 🛷 for ${String(pair_id)}: "quoted" \\ back'slash`,
        _dogsled_evidence: null,
        _dogsled_confidence: null,
        _dogsled_reason: null,
      })),
    };
  };
  const context = {
    ...fixture.context(),
    resolved: resolveAgenticModel(fixture.model, fixture.host),
  };
  return recorded('conformance-plan', fixture.host, context, {
    publisher,
    cursorStore: memoryCursors(),
  });
}
