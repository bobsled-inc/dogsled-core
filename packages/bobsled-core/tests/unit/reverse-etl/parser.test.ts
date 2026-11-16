import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import type { Action } from '@bobsled-inc/integrations';
import type { ActionSpec } from '@bobsled-inc/extractor/extractor';

const integrationMocks = vi.hoisted(() => ({
  actions: [] as Action[],
  loadActionsError: undefined as Error | undefined,
  projectActionsError: undefined as Error | undefined,
}));

vi.mock('@bobsled-inc/integrations', async () => {
  const actual = await vi.importActual<typeof import('@bobsled-inc/integrations')>(
    '@bobsled-inc/integrations'
  );
  return {
    ...actual,
    loadBuiltInActions: vi.fn((projectActions?: unknown) => {
      if (projectActions && integrationMocks.projectActionsError) {
        throw integrationMocks.projectActionsError;
      }
      if (integrationMocks.loadActionsError) {
        throw integrationMocks.loadActionsError;
      }
      return integrationMocks.actions;
    }),
  };
});

import { parseReverseEtlProject } from '../../../src/reverse-etl/index.js';

interface WebhookActionFixture {
  spec_version: '1';
  type: 'action';
  transport: 'webhook';
  name: string;
  integration: 'custom_webhook';
  description: string;
  webhook: {
    url: string;
    method: 'POST';
  };
  input: {
    email: { type: 'string'; required: true };
    full_name: { type: 'string' };
  };
}

interface SyncFixture {
  spec_version: '1';
  type: 'sync';
  name: string;
  schedule: string;
  source: {
    type: 'projection';
    connection: string;
    projection_ref: string;
    cursor: {
      field: string;
      initial_value: string;
    };
  };
  target: {
    action: string;
    destination_connection?: string;
    entity_key: { fields: string[] };
    input_mapping: Record<string, string>;
  };
}

const projectRoots: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-reverse-etl-'));
  projectRoots.push(dir);
  fs.mkdirSync(path.join(dir, 'syncs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'actions'), { recursive: true });
  return dir;
}

function writeYaml(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(value), 'utf-8');
}

function validWebhookAction(name = 'notify_contact'): WebhookActionFixture {
  return {
    spec_version: '1',
    type: 'action',
    transport: 'webhook',
    name,
    integration: 'custom_webhook',
    description: 'Notify an external contact system',
    webhook: {
      url: 'https://hooks.example.com/contacts',
      method: 'POST',
    },
    input: {
      email: { type: 'string', required: true },
      full_name: { type: 'string' },
    },
  };
}

function validSync(name = 'contacts_to_webhook'): SyncFixture {
  return {
    spec_version: '1',
    type: 'sync',
    name,
    schedule: 'daily',
    source: {
      type: 'projection',
      connection: 'warehouse_prod',
      projection_ref: 'mart.contacts_activation',
      cursor: {
        field: 'observed_at',
        initial_value: '1970-01-01T00:00:00.000Z',
      },
    },
    target: {
      action: 'custom_webhook/notify_contact',
      destination_connection: 'notion_workspace',
      entity_key: { fields: ['email'] },
      input_mapping: {
        email: 'email',
        full_name: 'full_name',
      },
    },
  };
}

function registryActionFromFixture(fixture: WebhookActionFixture): Action {
  return {
    name: fixture.name,
    qualifiedName: `${fixture.integration}/${fixture.name}`,
    integration: fixture.integration,
    transport: fixture.transport,
    tags: [],
    description: fixture.description,
    inputs: fixture.input,
    spec: fixture as ActionSpec,
    filePath: `/virtual/project-actions/${fixture.name}.yml`,
  };
}

beforeEach(() => {
  integrationMocks.actions = [];
  integrationMocks.loadActionsError = undefined;
  integrationMocks.projectActionsError = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of projectRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseReverseEtlProject', () => {
  it('returns parsed syncs, project actions, and no errors for a valid project', () => {
    const projectRoot = makeTempProject();
    const action = validWebhookAction();
    integrationMocks.actions = [registryActionFromFixture(action)];
    writeYaml(path.join(projectRoot, 'actions', 'notify_contact.yml'), action);
    writeYaml(path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'), validSync());

    const result = parseReverseEtlProject(projectRoot);

    expect(result.errors).toEqual([]);
    expect(result.syncs.map((sync) => sync.name)).toEqual(['contacts_to_webhook']);
    expect(result.syncs[0]?.spec.schedule).toBe('daily');
    expect(result.syncs[0]?.spec.target.destination_connection).toBe('notion_workspace');
    expect(result.actions.map((parsedAction) => parsedAction.qualifiedName)).toEqual([
      'custom_webhook/notify_contact',
    ]);
  });

  it('reports two syncs that declare the same name, naming both files', () => {
    const projectRoot = makeTempProject();
    integrationMocks.actions = [registryActionFromFixture(validWebhookAction())];
    writeYaml(path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'), validSync());
    writeYaml(path.join(projectRoot, 'crm', 'contacts.yml'), validSync());

    const result = parseReverseEtlProject(projectRoot);

    const message =
      'Duplicate sync name "contacts_to_webhook" in crm/contacts.yml and syncs/contacts_to_webhook.yml.';
    expect(result.syncs).toEqual([]);
    expect(result.errors).toEqual([
      { kind: 'sync', file: path.join(projectRoot, 'crm', 'contacts.yml'), message },
      { kind: 'sync', file: path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'), message },
    ]);
  });

  it('aggregates sync schema errors, action schema errors, and bobsled.yml name collisions', () => {
    const projectRoot = makeTempProject();
    integrationMocks.actions = [registryActionFromFixture(validWebhookAction())];
    writeYaml(path.join(projectRoot, 'bobsled.yaml'), {
      pipelines: {
        contacts_to_webhook: {
          type: 'models',
          connection: 'warehouse_prod',
          schedule: 'daily',
          models: ['stg_contacts'],
        },
      },
    });
    writeYaml(path.join(projectRoot, 'actions', 'broken.yml'), {
      type: 'action',
      transport: 'webhook',
      name: 'broken',
      description: 'Missing webhook URL',
      webhook: {},
      input: {},
    });
    writeYaml(path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'), {
      ...validSync(),
      target: {
        action: 'missing/action',
        entity_key: { fields: ['email'] },
        input_mapping: { email: 'email' },
      },
    });

    const result = parseReverseEtlProject(projectRoot);

    expect(result.syncs).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.errors.map((error) => error.kind)).toEqual(
      expect.arrayContaining(['sync', 'action', 'bobsled-config'])
    );
    expect(result.errors.map((error) => error.file)).toEqual(
      expect.arrayContaining([
        path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'),
        path.join(projectRoot, 'actions', 'broken.yml'),
        'bobsled.yaml',
      ])
    );
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'collides with pipeline "contacts_to_webhook" in bobsled.yaml'
    );
  });

  it('validates sync schedules even when action registry loading fails', () => {
    const projectRoot = makeTempProject();
    integrationMocks.loadActionsError = new Error('registry unavailable');
    writeYaml(path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'), {
      ...validSync(),
      schedule: 'not a schedule',
    });

    const result = parseReverseEtlProject(projectRoot);

    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining(['registry unavailable', 'Invalid sync schedule "not a schedule"'])
    );
  });

  it('does not validate sync action references against an incomplete fallback registry', () => {
    const projectRoot = makeTempProject();
    integrationMocks.projectActionsError = new Error('project actions unavailable');
    integrationMocks.actions = [
      {
        ...registryActionFromFixture(validWebhookAction('bundled_notify')),
        qualifiedName: 'bundled/notify',
        integration: 'bundled',
      },
    ];
    writeYaml(path.join(projectRoot, 'actions', 'notify_contact.yml'), validWebhookAction());
    writeYaml(path.join(projectRoot, 'syncs', 'contacts_to_webhook.yml'), validSync());

    const result = parseReverseEtlProject(projectRoot);

    expect(result.syncs.map((sync) => sync.name)).toEqual(['contacts_to_webhook']);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining(['project actions unavailable'])
    );
    expect(result.errors.map((error) => error.message).join('\n')).not.toContain(
      'Action not found'
    );
  });
});
