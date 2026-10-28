import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEARN_CURRICULUM_VERSION,
  LEARN_MODULES,
  getLearnModuleById,
} from '../src/lib/learn-curriculum';
import {
  LEARN_PROGRESS_STORAGE_KEY,
  getLearnProgressSummary,
  readLearnProgress,
  sanitizeLearnProgress,
} from '../src/lib/learn-progress';

class LocalStorageMock {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('sanitizeLearnProgress drops stale versions and invalid steps', () => {
  const module = getLearnModuleById('entity-graph-deep-dive');
  assert.ok(module);

  const stale = sanitizeLearnProgress({ version: 'old', modules: {} });
  assert.equal(stale.version, LEARN_CURRICULUM_VERSION);
  assert.deepEqual(stale.modules, {});

  const sanitized = sanitizeLearnProgress({
    version: LEARN_CURRICULUM_VERSION,
    modules: {
      'entity-graph-deep-dive': {
        completedStepIds: ['design-resolution', 'bad-step', 'design-resolution'],
        lastStepId: 'inspect-review-queue',
      },
      bogus: {
        completedStepIds: ['x'],
        lastStepId: 'x',
      },
    },
  });

  assert.deepEqual(sanitized.modules['entity-graph-deep-dive']?.completedStepIds, [
    'design-resolution',
  ]);
  assert.equal(sanitized.modules['entity-graph-deep-dive']?.lastStepId, 'inspect-review-queue');
  assert.equal(sanitized.modules['bogus'], undefined);
});

test('getLearnProgressSummary reports completion and resume state', () => {
  const module = LEARN_MODULES[0];
  assert.ok(module);
  const firstStep = module.steps[0];
  assert.ok(firstStep);

  const summary = getLearnProgressSummary(
    {
      version: LEARN_CURRICULUM_VERSION,
      modules: {
        [module.id]: {
          completedStepIds: [firstStep.id],
          lastStepId: firstStep.id,
        },
      },
    },
    module.id
  );

  assert.equal(summary.completedCount, 1);
  assert.equal(summary.totalSteps, module.steps.length);
  assert.equal(summary.lastStepId, firstStep.id);
  assert.equal(summary.isComplete, module.steps.length === 1);
});

test('readLearnProgress tolerates localStorage failures', () => {
  const originalWindow = globalThis.window;
  try {
    globalThis.window = {
      localStorage: {
        getItem() {
          throw new Error('storage blocked');
        },
      },
    } as unknown as Window & typeof globalThis;

    const state = readLearnProgress();
    assert.equal(state.version, LEARN_CURRICULUM_VERSION);
    assert.deepEqual(state.modules, {});
  } finally {
    globalThis.window = originalWindow;
  }
});

test('readLearnProgress loads valid persisted progress', () => {
  const originalWindow = globalThis.window;
  try {
    const localStorage = new LocalStorageMock();
    localStorage.setItem(
      LEARN_PROGRESS_STORAGE_KEY,
      JSON.stringify({
        version: LEARN_CURRICULUM_VERSION,
        modules: {
          foundations: {
            completedStepIds: ['protocol-first'],
            lastStepId: 'protocol-first',
          },
        },
      })
    );
    globalThis.window = {
      localStorage,
      dispatchEvent() {
        return true;
      },
    } as unknown as Window & typeof globalThis;

    const state = readLearnProgress();
    assert.deepEqual(state.modules['foundations']?.completedStepIds, ['protocol-first']);
  } finally {
    globalThis.window = originalWindow;
  }
});
