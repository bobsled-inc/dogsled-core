import { beforeAll, describe, expect, it } from 'vitest';
import {
  agenticCommandItems,
  agenticCreateItems,
  agenticRunSummary,
  agenticStoredRows,
  assembleAgenticWrites,
  createAgenticRowWrite,
  isAgenticRunReclaimable,
  rebuildAgenticSnapshot,
  splitAgenticRowText,
  walkAgenticWrites,
  type AgenticRowWrite,
  type AgenticWriteInfo,
} from '../../../src/agentic/row-state-layout.js';
import {
  AgenticRunSnapshotSchema,
  applyAgenticCheckpoint,
  digestAgenticState,
  type AgenticRunSnapshot,
} from '../../../src/agentic/state.js';
import {
  currentCommand,
  mapScenario,
  planScenario,
  type AgenticStoreScenario,
} from '../../support/agentic-store-scenario.js';

const info = (write: AgenticRowWrite): AgenticWriteInfo => ({
  write_id: write.id,
  parent: write.parent,
  revision: write.revision,
});
const item = (data: string) => ({ kind: 'assignment' as const, data });

/** Every state of a scenario, with the writes a store would keep for it. */
function follow(scenario: AgenticStoreScenario) {
  let snapshot = AgenticRunSnapshotSchema.parse(scenario.initial);
  const writes = [createAgenticRowWrite('', 0, 'create', agenticCreateItems(snapshot))];
  const states: { snapshot: AgenticRunSnapshot; writes: AgenticRowWrite[] }[] = [
    { snapshot, writes: [...writes] },
  ];
  for (const recorded of scenario.commands) {
    const command = currentCommand(snapshot, recorded);
    const next = applyAgenticCheckpoint(snapshot, command);
    const items = agenticCommandItems(next, command, snapshot.work.length);
    if (items.length) {
      const parent = writes.at(-1)!.id;
      writes.push(createAgenticRowWrite(parent, next.revision, command.operation_id, items));
    }
    snapshot = next;
    states.push({ snapshot, writes: [...writes] });
  }
  return states;
}

describe('agentic row layout', () => {
  let map: AgenticStoreScenario;
  let plan: AgenticStoreScenario;
  beforeAll(async () => {
    map = await mapScenario();
    plan = await planScenario();
  });

  it.each(['map', 'plan'] as const)('rebuilds every state of a %s run exactly', (name) => {
    const scenario = name === 'map' ? map : plan;
    for (const { snapshot, writes } of follow(scenario)) {
      const rebuilt = rebuildAgenticSnapshot(
        { key: snapshot.key, revision: snapshot.revision, summary: agenticRunSummary(snapshot) },
        writes
      );
      expect(digestAgenticState(rebuilt)).toBe(digestAgenticState(snapshot));
      expect(() => AgenticRunSnapshotSchema.parse(rebuilt)).not.toThrow();
    }
  });

  it('keeps large content out of the header summary', () => {
    const { snapshot } = follow(plan).at(-1)!;
    const summary = JSON.parse(agenticRunSummary(snapshot));
    for (const field of ['definition', 'plan_inputs', 'cursor_values', 'work', 'key']) {
      expect(summary).not.toHaveProperty(field);
    }
    expect(Buffer.byteLength(agenticRunSummary(snapshot))).toBeLessThan(4096);
  });

  it('writes no rows for commands that change only header fields', () => {
    const states = follow(plan);
    const headerOnly = [
      'complete',
      'prepare_publication',
      'confirm_publication',
      'confirm_cursors',
    ];
    plan.commands.forEach((command, index) => {
      if (!headerOnly.includes(command.type)) return;
      expect(states[index + 1]!.writes).toHaveLength(states[index]!.writes.length);
    });
  });

  it('gives repeated content the same ID and changed content a new one', () => {
    const write = createAgenticRowWrite('parent', 3, 'op', [item('a')]);
    expect(createAgenticRowWrite('parent', 3, 'op', [item('a')]).id).toBe(write.id);
    for (const other of [
      createAgenticRowWrite('parent', 3, 'op', [item('b')]),
      createAgenticRowWrite('other', 3, 'op', [item('a')]),
      createAgenticRowWrite('parent', 4, 'op', [item('a')]),
      createAgenticRowWrite('parent', 3, 'other', [item('a')]),
      createAgenticRowWrite('parent', 3, 'op', [item('a'), item('')]),
    ]) {
      expect(other.id).not.toBe(write.id);
    }
  });

  it('does not confuse field boundaries', () => {
    expect(createAgenticRowWrite('', 1, 'ab', [item('c')]).id).not.toBe(
      createAgenticRowWrite('', 1, 'a', [item('bc')]).id
    );
  });

  describe('chain', () => {
    const first = createAgenticRowWrite('', 0, 'create', [item('one')]);
    const second = createAgenticRowWrite(first.id, 1, 'two', [item('two')]);
    const third = createAgenticRowWrite(second.id, 2, 'three', [item('three')]);
    const orphan = createAgenticRowWrite(second.id, 2, 'orphan', [item('orphan')]);

    it('finds committed writes and orphans, whatever their revision', () => {
      const walked = walkAgenticWrites([first, second, third, orphan].map(info), third.id, 2);
      expect([...walked.committed]).toEqual([third.id, second.id, first.id]);
      expect(walked.orphans).toEqual([orphan.id]);
    });

    it('ignores rows newer than the header', () => {
      const walked = walkAgenticWrites([first, second, third].map(info), second.id, 1);
      expect(walked.orphans).toEqual([third.id]);
    });

    it('allows revisions without rows between writes', () => {
      const later = createAgenticRowWrite(first.id, 7, 'later', [item('later')]);
      const walked = walkAgenticWrites([first, later].map(info), later.id, 9);
      expect(walked.committed.size).toBe(2);
    });

    it.each([
      ['before', [info(first), { ...info(second), parent: 'a'.repeat(64) }, info(second)]],
      ['after', [info(first), info(second), { ...info(second), parent: 'a'.repeat(64) }]],
    ])('rejects a write ID stored with two parents, the other one %s', (_, infos) => {
      expect(() => walkAgenticWrites(infos, second.id, 1)).toThrow(
        expect.objectContaining({ code: 'corrupt' })
      );
    });

    it.each([
      ['a missing head', [first], 'unknown', 2],
      ['a broken parent', [third], third.id, 2],
      ['a head newer than the header', [first, second, third], third.id, 1],
      [
        'a parent that is not older',
        [{ ...info(first), parent: second.id }, info(second)],
        second.id,
        1,
      ],
      [
        'a cycle',
        [
          { ...info(first), parent: second.id, revision: 3 },
          { ...info(second), revision: 2 },
        ],
        second.id,
        3,
      ],
    ])('rejects %s', (_, writes, head, revision) => {
      const infos = (writes as (AgenticRowWrite | AgenticWriteInfo)[]).map((write) =>
        'items' in write ? info(write) : write
      );
      expect(() => walkAgenticWrites(infos, head as string, revision as number)).toThrow(
        expect.objectContaining({ code: 'corrupt' })
      );
    });
  });

  describe('stored rows', () => {
    const write = createAgenticRowWrite('', 0, 'create', [item('x'.repeat(250)), item('short')]);
    const committed = new Set([write.id]);

    it('round-trips long items through several rows', () => {
      const rows = agenticStoredRows(write, 100);
      expect(rows.map((row) => [row.item, row.part, row.parts])).toEqual([
        [0, 0, 3],
        [0, 1, 3],
        [0, 2, 3],
        [1, 0, 1],
      ]);
      expect(assembleAgenticWrites(rows, committed)).toEqual([write]);
      expect(assembleAgenticWrites([...rows].reverse(), committed)).toEqual([write]);
    });

    it('tolerates identical repeats and rejects differing ones', () => {
      const rows = agenticStoredRows(write, 100);
      expect(assembleAgenticWrites([...rows, rows[1]!], committed)).toEqual([write]);
      expect(() =>
        assembleAgenticWrites([...rows, { ...rows[1]!, data: 'changed' }], committed)
      ).toThrow(expect.objectContaining({ code: 'corrupt' }));
    });

    it.each([
      ['a lost part', (rows: ReturnType<typeof agenticStoredRows>) => rows.slice(1)],
      ['a lost item', (rows: ReturnType<typeof agenticStoredRows>) => rows.slice(0, 3)],
      [
        'edited content',
        (rows: ReturnType<typeof agenticStoredRows>) =>
          rows.map((row) => (row.part === 1 ? { ...row, data: `${row.data}!` } : row)),
      ],
      [
        'a changed kind',
        (rows: ReturnType<typeof agenticStoredRows>) =>
          rows.map((row) => ({ ...row, kind: 'attempt' as const })),
      ],
      [
        'an unknown kind',
        (rows: ReturnType<typeof agenticStoredRows>) =>
          rows.map((row) => ({ ...row, kind: 'other' as 'attempt' })),
      ],
      ['no rows', () => []],
    ])('rejects %s', (_, damage) => {
      expect(() => assembleAgenticWrites(damage(agenticStoredRows(write, 100)), committed)).toThrow(
        expect.objectContaining({ code: 'corrupt' })
      );
    });

    it('never splits a surrogate pair', () => {
      const text = '🛷'.repeat(50);
      for (const size of [3, 4, 7]) {
        const parts = splitAgenticRowText(text, size);
        expect(parts.join('')).toBe(text);
        for (const part of parts) expect(part.isWellFormed()).toBe(true);
      }
    });

    it('still makes progress when one pair is wider than a part', () => {
      expect(splitAgenticRowText('🛷', 1).join('')).toBe('🛷');
    });
  });

  describe('retention', () => {
    it('holds back runs that are still owed recovery', () => {
      const states = follow(plan).map(({ snapshot }) => snapshot);
      // A sealed incremental batch stays until its cursor is committed.
      for (const state of states.slice(1, -1)) expect(isAgenticRunReclaimable(state)).toBe(false);
      expect(isAgenticRunReclaimable(states.at(-1)!)).toBe(true);
      expect(isAgenticRunReclaimable({ ...states[2]!, superseded: true })).toBe(true);
    });

    it('releases a preparing run, which has nothing to lose', () => {
      const [preparing] = follow(plan).map(({ snapshot }) => snapshot);
      expect(preparing!.status).toBe('preparing');
      expect(isAgenticRunReclaimable(preparing!)).toBe(true);
    });

    it('releases finished work that owes nothing', () => {
      for (const { snapshot } of follow(map)) expect(isAgenticRunReclaimable(snapshot)).toBe(true);
    });
  });
});
