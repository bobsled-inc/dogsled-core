import { describe, expect, it, vi } from 'vitest';
import {
  AgentAssignmentSchema,
  AgenticModelSpecSchema,
  executeAgenticRun,
  parseAgentAssignmentOutcome,
} from '../../../src/agentic/index.js';
import { assignment } from './fixtures.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

describe('host tools', () => {
  it('rejects tools for direct calls and duplicate tool names', () => {
    const model = runFixture(1).model;
    model.plan.steps[0]!.execution = { mode: 'llm_call', tools: ['web_search'] };
    expect(AgenticModelSpecSchema.safeParse(model).success).toBe(false);
    model.plan.steps[0]!.execution = { mode: 'agent_loop', tools: ['web_search', 'web_search'] };
    expect(AgenticModelSpecSchema.safeParse(model).success).toBe(false);
  });

  it('requires host support before preparation or state writes', async () => {
    const f = runFixture(1);
    f.model.plan.steps[0]!.execution = { mode: 'agent_loop', tools: ['web_search'] };
    const prepare = vi.fn(f.host.prepare);
    const store = new MemoryStateStore();
    await expect(
      executeAgenticRun({ ...f.host, prepare, sources: vi.fn() }, f.context(), {
        projectDirectory: '/unused',
        stateStore: store,
        run: { id: 'tools', mode: 'start' },
      })
    ).rejects.toThrow('tool');
    expect(prepare).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
  });

  it('saves declared tools in assignments and resumes without more calls', async () => {
    const f = runFixture(1);
    f.model.plan.steps[0]!.execution = { mode: 'agent_loop', tools: ['web_search'] };
    const executeAgent = vi.fn(f.host.executeAgent);
    const host = { ...f.host, executeAgent, sources: vi.fn(), supportedTools: ['web_search'] };
    const options = {
      projectDirectory: '/unused',
      stateStore: new MemoryStateStore(),
      run: { id: 'tools', mode: 'start' as const },
    };
    await executeAgenticRun(host, f.context(), options);
    expect(executeAgent.mock.calls[0]![0].assignment.allowed_tools).toEqual(['web_search']);
    await executeAgenticRun(host, f.context(), {
      ...options,
      run: { id: 'tools', mode: 'resume' },
    });
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, [], ['web_fetch']])(
    'binds default or restricted tools: %j',
    async (tools) => {
      const f = runFixture(1);
      f.model.plan.steps[0]!.execution = {
        mode: 'agent_loop',
        ...(tools === undefined ? {} : { tools }),
      };
      const executeAgent = vi.fn(f.host.executeAgent);
      const host = {
        ...f.host,
        executeAgent,
        sources: vi.fn(),
        supportedTools: ['web_search', 'web_fetch'],
      };
      const options = {
        projectDirectory: '/unused',
        stateStore: new MemoryStateStore(),
        run: { id: 'defaults', mode: 'start' as const },
      };
      await executeAgenticRun(host, f.context(), options);
      expect(executeAgent.mock.calls[0]![0].assignment.allowed_tools).toEqual(
        tools ?? host.supportedTools
      );
      await executeAgenticRun(host, f.context(), {
        ...options,
        run: { id: 'defaults', mode: 'resume' },
      });
      expect(executeAgent).toHaveBeenCalledTimes(1);
      if (tools === undefined) {
        await expect(
          executeAgenticRun({ ...host, supportedTools: ['web_fetch'] }, f.context(), {
            ...options,
            run: { id: 'defaults', mode: 'resume' },
          })
        ).rejects.toThrow();
      }
    }
  );

  it('accepts evidence from declared tools only', () => {
    const work = AgentAssignmentSchema.parse({
      ...assignment(),
      mode: 'agent_loop',
      allowed_tools: ['web_fetch'],
    });
    const outcome = {
      contract_version: 2,
      attempt_id: work.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [
        {
          pair_id: 'pair-1',
          assessment: 'uncertain',
          _bobsled_confidence: null,
          _bobsled_reason: null,
          _bobsled_evidence: [
            {
              source: 'web_fetch',
              support_excerpt: null,
              reference: 'https://example.com',
              retrieved_at: '2026-09-11T10:01:00Z',
            },
          ],
        },
      ],
    };
    expect(() => parseAgentAssignmentOutcome(work, outcome)).not.toThrow();
    expect(() => parseAgentAssignmentOutcome({ ...work, allowed_tools: [] }, outcome)).toThrow();
  });
});
