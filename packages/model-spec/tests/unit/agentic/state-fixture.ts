import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AgenticModelSpecSchema, resolveAgenticModel } from '../../../src/agentic/index.js';
import type {
  ExperimentalAgenticProbe,
  AgenticStateStore,
  AgenticRunSnapshot,
  AgenticRunKey,
} from '../../../src/agentic/index.js';
import {
  AgenticStateError,
  applyAgenticCheckpoint,
  digestAgenticState,
} from '../../../src/agentic/index.js';

export function runFixture(count = 20) {
  const model = AgenticModelSpecSchema.parse(
    parse(
      readFileSync(new URL('../../fixtures/agentic/prepared-pairs.yml', import.meta.url), 'utf8')
    )
  );
  const host: ExperimentalAgenticProbe = {
    supportedDialects: ['duckdb'],
    tokensPerAssignment: 100,
    inputs: { undecided_pairs: [{ name: 'pair_id', type: 'string', nullable: false }] },
    platform: {
      models: {
        review: {
          provider: 'openai',
          model: 'fake',
          api_key: '$FAKE_KEY',
          auth_env_vars: ['FAKE_KEY'],
        },
      },
    },
    async prepare() {
      return Array.from({ length: count }, (_, index) => ({ pair_id: `p${index}` }));
    },
    async executeAgent({ assignment, budget }) {
      const reservation = await budget.reserve(100);
      const usage = {
        status: 'measured' as const,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      };
      await budget.settle(reservation, usage);
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage,
        rows: [],
      };
    },
    async publish() {},
  };
  const context = () => ({
    resolved: resolveAgenticModel(model, host),
    integration: 'lake',
    target: 'main.pair_assessments',
    inputRef: 'undecided_pairs',
  });
  return { host, model, context };
}

/** A supplied-store contract fixture. Production hosts must persist this transaction durably. */
export class MemoryStateStore implements AgenticStateStore {
  runs = new Map<string, AgenticRunSnapshot>();
  owners = new Set<string>();
  async acquire(key: AgenticRunKey) {
    const id = digestAgenticState(key);
    if (this.owners.has(id)) throw new AgenticStateError('conflict');
    this.owners.add(id);
    let active = true;
    const guard = () => {
      if (!active) throw new AgenticStateError('conflict');
    };
    return {
      read: async () => {
        guard();
        return structuredClone(this.runs.get(id) ?? null);
      },
      create: async (snapshot: AgenticRunSnapshot) => {
        guard();
        if (this.runs.has(id)) throw new AgenticStateError('conflict');
        this.runs.set(id, structuredClone(snapshot));
        return structuredClone(snapshot);
      },
      checkpoint: async (command: Parameters<typeof applyAgenticCheckpoint>[1]) => {
        guard();
        const snapshot = this.runs.get(id);
        if (!snapshot) throw new AgenticStateError('missing');
        const next = applyAgenticCheckpoint(snapshot, command);
        this.runs.set(id, next);
        return structuredClone(next);
      },
      release: async () => {
        guard();
        active = false;
        this.owners.delete(id);
      },
    };
  }
}
