import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPersistedEntityGraphWizardState,
  clearPersistedEntityGraphWizardStateForContext,
  createBlankResolutionSpec,
  getEntityGraphWizardStorageKey,
  loadPersistedEntityGraphWizardState,
  loadPersistedEntityGraphWizardStateForContext,
  ENTITY_GRAPH_WIZARD_STORAGE_KEY,
  savePersistedEntityGraphWizardState,
  savePersistedEntityGraphWizardStateForContext,
  type PersistedEntityGraphWizardState,
} from '../src/lib/entity-graph-wizard-state';

interface StorageStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createStorageStub(initial?: Record<string, string>): StorageStub & { removed: string[] } {
  const store = new Map(Object.entries(initial ?? {}));
  const removed: string[] = [];

  return {
    removed,
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      removed.push(key);
      store.delete(key);
    },
  };
}

test('reset blank spec starts from the canonical blank resolution draft', () => {
  assert.deepEqual(createBlankResolutionSpec('company_resolution'), {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: '',
    inputs: [],
    standardize: [],
    blocking: { rules: [] },
    scoring: { method: 'weighted_features', features: [] },
    thresholds: { auto_merge: 0.93, review: 0.6, auto_reject: 0.5 },
  });
});

test('loadPersistedEntityGraphWizardState normalizes persisted spec collections before restore', () => {
  const storage = createStorageStub();
  const state: PersistedEntityGraphWizardState = {
    step: 'standardize',
    specName: 'company_resolution',
    spec: {
      name: 'company_resolution',
      type: 'resolution',
      description: 'Draft',
      inputs: 'bad-data' as never,
      standardize: [{ field: 'name', transforms: 'lowercase' as never }],
      blocking: { rules: 'bad-data' as never, candidate_limit: 1000 },
      scoring: { method: 'weighted_features', features: 'bad-data' as never },
      thresholds: { auto_merge: 0.9, review: 0.7, auto_reject: 0.5 },
    },
    yamlText: 'name: company_resolution',
    yamlDirty: false,
    savedAt: '2026-04-19T18:00:00.000Z',
  };

  savePersistedEntityGraphWizardState(state, storage);

  assert.deepEqual(loadPersistedEntityGraphWizardState(storage), {
    ...state,
    spec: {
      name: 'company_resolution',
      type: 'resolution',
      description: 'Draft',
      inputs: [],
      standardize: [{ field: 'name', transforms: [] }],
      blocking: { rules: [], candidate_limit: 1000 },
      scoring: { method: 'weighted_features', features: [] },
      thresholds: { auto_merge: 0.9, review: 0.7, auto_reject: 0.5 },
    },
  });
});

test('loadPersistedEntityGraphWizardState clears invalid saved payloads', () => {
  const storage = createStorageStub({
    [ENTITY_GRAPH_WIZARD_STORAGE_KEY]: JSON.stringify({
      step: 'not-a-real-step',
      specName: 'company_resolution',
      spec: {},
      yamlText: '',
      yamlDirty: false,
      savedAt: '2026-04-19T18:00:00.000Z',
    }),
  });

  assert.equal(loadPersistedEntityGraphWizardState(storage), null);
  assert.deepEqual(storage.removed, [ENTITY_GRAPH_WIZARD_STORAGE_KEY]);
});

test('loadPersistedEntityGraphWizardState clears non-object JSON payloads', () => {
  const storage = createStorageStub({
    [ENTITY_GRAPH_WIZARD_STORAGE_KEY]: JSON.stringify(['overview']),
  });

  assert.equal(loadPersistedEntityGraphWizardState(storage), null);
  assert.deepEqual(storage.removed, [ENTITY_GRAPH_WIZARD_STORAGE_KEY]);
});

test('loadPersistedEntityGraphWizardState clears non-resolution drafts before restore', () => {
  const storage = createStorageStub({
    [ENTITY_GRAPH_WIZARD_STORAGE_KEY]: JSON.stringify({
      step: 'overview',
      specName: 'company_survivorship',
      spec: {
        name: 'company_survivorship',
        type: 'survivorship',
      },
      yamlText: 'name: company_survivorship',
      yamlDirty: false,
      savedAt: '2026-04-19T18:00:00.000Z',
    }),
  });

  assert.equal(loadPersistedEntityGraphWizardState(storage), null);
  assert.deepEqual(storage.removed, [ENTITY_GRAPH_WIZARD_STORAGE_KEY]);
});

for (const scoped of [false, true]) {
  test(`stored retired scenarios cannot restore into the default wizard (${scoped ? 'scoped' : 'legacy'})`, () => {
    const context = { scenarioId: 'default' as const, entityId: 'company' as const };
    const key = scoped ? getEntityGraphWizardStorageKey(context) : ENTITY_GRAPH_WIZARD_STORAGE_KEY;
    const storage = createStorageStub({
      [key]: JSON.stringify({
        scenarioId: 'retired-demo',
        entityId: 'company',
        step: 'overview',
        specName: 'company_resolution',
        spec: createBlankResolutionSpec('company_resolution'),
        yamlText: 'name: company_resolution',
        yamlDirty: false,
        savedAt: '2026-04-19T18:00:00.000Z',
      }),
    });

    assert.equal(loadPersistedEntityGraphWizardStateForContext(context, storage), null);
    assert.deepEqual(storage.removed, [key]);
  });
}

test('clearPersistedEntityGraphWizardState removes the saved draft key', () => {
  const storage = createStorageStub({
    [ENTITY_GRAPH_WIZARD_STORAGE_KEY]: JSON.stringify({ step: 'overview' }),
  });

  clearPersistedEntityGraphWizardState(storage);

  assert.equal(storage.getItem(ENTITY_GRAPH_WIZARD_STORAGE_KEY), null);
});

test('loadPersistedEntityGraphWizardState returns null when localStorage access throws', () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = globalWithWindow.window;

  Object.defineProperty(globalWithWindow, 'window', {
    configurable: true,
    value: {
      get localStorage() {
        throw new Error('storage blocked');
      },
    },
  });

  try {
    assert.equal(loadPersistedEntityGraphWizardState(), null);
  } finally {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalWithWindow, 'window');
    } else {
      Object.defineProperty(globalWithWindow, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  }
});

test('savePersistedEntityGraphWizardState swallows storage write failures', () => {
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('quota exceeded');
    },
    removeItem() {
      throw new Error('remove blocked');
    },
  };

  assert.doesNotThrow(() =>
    savePersistedEntityGraphWizardState(
      {
        step: 'overview',
        specName: 'company_resolution',
        spec: createBlankResolutionSpec('company_resolution'),
        yamlText: 'name: company_resolution',
        yamlDirty: false,
        savedAt: '2026-04-19T18:00:00.000Z',
      },
      storage
    )
  );
});

test('clearPersistedEntityGraphWizardState swallows storage removal failures', () => {
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      return undefined;
    },
    removeItem() {
      throw new Error('remove blocked');
    },
  };

  assert.doesNotThrow(() => clearPersistedEntityGraphWizardState(storage));
});

test('context-specific draft storage stays isolated per scenario and entity', () => {
  const storage = createStorageStub();
  const customerContext = { scenarioId: 'default' as const, entityId: 'customer' as const };
  const locationContext = { scenarioId: 'default' as const, entityId: 'location' as const };

  savePersistedEntityGraphWizardStateForContext(
    customerContext,
    {
      step: 'overview',
      specName: 'customer_resolution',
      spec: createBlankResolutionSpec('customer_resolution'),
      yamlText: 'name: customer_resolution',
      yamlDirty: false,
      savedAt: '2026-04-20T12:00:00.000Z',
    },
    storage
  );
  savePersistedEntityGraphWizardStateForContext(
    locationContext,
    {
      step: 'review',
      specName: 'location_resolution',
      spec: createBlankResolutionSpec('location_resolution'),
      yamlText: 'name: location_resolution',
      yamlDirty: true,
      savedAt: '2026-04-20T12:05:00.000Z',
    },
    storage
  );

  assert.equal(storage.getItem(getEntityGraphWizardStorageKey(customerContext)) !== null, true);
  assert.equal(
    loadPersistedEntityGraphWizardStateForContext(customerContext, storage)?.specName,
    'customer_resolution'
  );
  assert.equal(
    loadPersistedEntityGraphWizardStateForContext(locationContext, storage)?.specName,
    'location_resolution'
  );

  clearPersistedEntityGraphWizardStateForContext(customerContext, storage);
  assert.equal(storage.getItem(getEntityGraphWizardStorageKey(customerContext)), null);
  assert.equal(storage.getItem(getEntityGraphWizardStorageKey(locationContext)) !== null, true);
});

test('context-specific loader falls back to the legacy single-key draft', () => {
  const storage = createStorageStub({
    [ENTITY_GRAPH_WIZARD_STORAGE_KEY]: JSON.stringify({
      step: 'review',
      specName: 'company_resolution',
      spec: createBlankResolutionSpec('company_resolution'),
      yamlText: 'name: company_resolution',
      yamlDirty: true,
      savedAt: '2026-04-20T12:10:00.000Z',
    }),
  });

  assert.deepEqual(
    loadPersistedEntityGraphWizardStateForContext(
      { scenarioId: 'default', entityId: 'company' },
      storage
    ),
    {
      scenarioId: 'default',
      entityId: 'company',
      step: 'review',
      specName: 'company_resolution',
      spec: {
        ...createBlankResolutionSpec('company_resolution'),
        blocking: { rules: [], candidate_limit: undefined },
      },
      yamlText: 'name: company_resolution',
      yamlDirty: true,
      savedAt: '2026-04-20T12:10:00.000Z',
    }
  );
});
