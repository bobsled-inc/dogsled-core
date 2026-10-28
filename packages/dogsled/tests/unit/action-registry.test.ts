import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { filterActions, findAction, loadActions } from '../../src/lib/action-registry.js';

type MockNode = { kind: 'dir' } | { kind: 'file'; content: string };

const mockNodes = new Map<string, MockNode>();
const INTEGRATIONS_DIR = '/virtual/integrations';
const PROJECT_ACTIONS_DIR = '/virtual/actions';

function makeApiActionSpec() {
  return {
    spec_version: '1',
    type: 'action',
    transport: 'api',
    name: 'upsert_contact',
    integration: 'salesforce',
    tags: ['crm', 'contacts'],
    description: 'Upsert a Salesforce contact',
    api: {
      endpoint: '/sobjects/Contact/Email/${{ input.email }}',
      method: 'PATCH',
    },
    input: {
      email: { type: 'string', required: true },
    },
    field_mapping: {
      fields: {
        email: 'email',
      },
    },
    activate: {
      operation: 'upsert',
      identity: {
        fields: ['email'],
        strategy: 'external_id',
      },
    },
  };
}

function makeWebhookActionSpec() {
  return {
    spec_version: '1',
    type: 'action',
    transport: 'webhook',
    name: 'notify_complete',
    tags: ['notifications'],
    description: 'Notify an external system',
    webhook: {
      url: 'https://hooks.example.com/notify',
      method: 'POST',
    },
    input: {
      entity_id: { type: 'string', required: true },
    },
  };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function ensureDir(dirPath: string): void {
  const normalized = normalizePath(dirPath);
  if (mockNodes.has(normalized)) {
    return;
  }

  mockNodes.set(normalized, { kind: 'dir' });
  const parent = normalizePath(path.dirname(normalized));
  if (parent !== normalized && parent !== '.') {
    ensureDir(parent);
  }
}

function addFile(filePath: string, content: string): void {
  const normalized = normalizePath(filePath);
  ensureDir(path.dirname(normalized));
  mockNodes.set(normalized, { kind: 'file', content });
}

function listDirEntries(dirPath: string): string[] {
  const normalized = normalizePath(dirPath).replace(/\/$/, '');
  const prefix = `${normalized}/`;
  const names = new Set<string>();

  for (const nodePath of mockNodes.keys()) {
    if (!nodePath.startsWith(prefix) || nodePath === normalized) {
      continue;
    }

    const remainder = nodePath.slice(prefix.length);
    const [name] = remainder.split('/');
    if (name) {
      names.add(name);
    }
  }

  return [...names];
}

function makeDirent(name: string, kind: 'file' | 'dir'): fs.Dirent {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
  } as fs.Dirent;
}

describe('action registry', () => {
  beforeEach(() => {
    mockNodes.clear();

    vi.mocked(fs.existsSync).mockImplementation((target) =>
      mockNodes.has(normalizePath(String(target)))
    );

    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const normalized = normalizePath(String(filePath));
      const node = mockNodes.get(normalized);
      if (!node || node.kind !== 'file') {
        throw new Error(`ENOENT: ${normalized}`);
      }
      return node.content as never;
    });

    vi.mocked(fs.statSync).mockImplementation((filePath) => {
      const normalized = normalizePath(String(filePath));
      const node = mockNodes.get(normalized);
      if (!node || node.kind !== 'file') {
        throw new Error(`ENOENT: ${normalized}`);
      }
      return {
        size: Buffer.byteLength(node.content, 'utf-8'),
      } as fs.Stats;
    });

    vi.mocked(fs.readdirSync).mockImplementation((dirPath, options) => {
      const normalized = normalizePath(String(dirPath));
      const names = listDirEntries(normalized);
      const withFileTypes = Boolean(
        options &&
        typeof options === 'object' &&
        'withFileTypes' in options &&
        options.withFileTypes === true
      );

      if (withFileTypes) {
        return names.map((name) => {
          const node = mockNodes.get(`${normalized}/${name}`);
          const kind = node?.kind === 'file' ? 'file' : 'dir';
          return makeDirent(name, kind);
        }) as never;
      }

      return names as never;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockNodes.clear();
  });

  it('loads bundled integration actions and project-local actions', () => {
    addFile(
      path.join(INTEGRATIONS_DIR, 'salesforce', 'actions', 'upsert_contact.yml'),
      YAML.stringify(makeApiActionSpec())
    );
    addFile(
      path.join(PROJECT_ACTIONS_DIR, 'notify_complete.yml'),
      YAML.stringify(makeWebhookActionSpec())
    );

    const actions = loadActions(INTEGRATIONS_DIR, PROJECT_ACTIONS_DIR);

    expect(actions.map((action) => action.qualifiedName)).toEqual([
      'notify_complete',
      'salesforce/upsert_contact',
    ]);
    expect(findAction(actions, 'salesforce/upsert_contact')).toEqual({
      kind: 'found',
      action: expect.objectContaining({ integration: 'salesforce' }),
    });
    expect(findAction(actions, 'notify_complete')).toEqual({
      kind: 'found',
      action: expect.objectContaining({ transport: 'webhook' }),
    });
  });

  it('filters by integration and tags', () => {
    addFile(
      path.join(INTEGRATIONS_DIR, 'salesforce', 'actions', 'upsert_contact.yml'),
      YAML.stringify(makeApiActionSpec())
    );

    const actions = loadActions(INTEGRATIONS_DIR);
    expect(filterActions(actions, { integration: 'salesforce' })).toHaveLength(1);
    expect(filterActions(actions, { tags: ['crm'] })).toHaveLength(1);
    expect(filterActions(actions, { tags: ['missing'] })).toHaveLength(0);
  });

  it('rejects duplicate qualified names', () => {
    addFile(
      path.join(INTEGRATIONS_DIR, 'salesforce', 'actions', 'upsert_contact.yml'),
      YAML.stringify(makeApiActionSpec())
    );
    addFile(
      path.join(PROJECT_ACTIONS_DIR, 'upsert_contact.yml'),
      YAML.stringify(makeApiActionSpec())
    );

    expect(() => loadActions(INTEGRATIONS_DIR, PROJECT_ACTIONS_DIR)).toThrow(
      'defined multiple times'
    );
  });

  it('rejects oversized action specs before parsing', () => {
    addFile(
      path.join(INTEGRATIONS_DIR, 'salesforce', 'actions', 'oversized.yml'),
      'x'.repeat(1_024 * 1_024 + 1)
    );

    expect(() => loadActions(INTEGRATIONS_DIR)).toThrow('exceeds maximum size of 1 MB');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('returns an ambiguous result when a bare action name matches multiple integrations', () => {
    addFile(
      path.join(INTEGRATIONS_DIR, 'salesforce', 'actions', 'upsert_contact.yml'),
      YAML.stringify(makeApiActionSpec())
    );
    addFile(
      path.join(INTEGRATIONS_DIR, 'hubspot', 'actions', 'upsert_contact.yml'),
      YAML.stringify({
        ...makeApiActionSpec(),
        integration: 'hubspot',
      })
    );

    const actions = loadActions(INTEGRATIONS_DIR);
    expect(findAction(actions, 'upsert_contact')).toEqual({
      kind: 'ambiguous',
      actions: [
        expect.objectContaining({ qualifiedName: 'hubspot/upsert_contact' }),
        expect.objectContaining({ qualifiedName: 'salesforce/upsert_contact' }),
      ],
    });
  });

  it('ignores .yaml action specs so runtime loading matches repo validation', () => {
    addFile(
      path.join(PROJECT_ACTIONS_DIR, 'notify_complete.yaml'),
      YAML.stringify(makeWebhookActionSpec())
    );

    expect(loadActions(INTEGRATIONS_DIR, PROJECT_ACTIONS_DIR)).toEqual([]);
  });
});
