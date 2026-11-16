import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectIndexError, scanProject } from '@bobsled-inc/project-index';
import { loadProject } from '@bobsled-inc/model-spec/project';
import { afterEach, describe, expect, it } from 'vitest';

import {
  generateProjectManifest,
  resolveProjectPipelines,
  BobsledProjectValidationError,
} from '../../src/manifest.js';
import {
  buildProjectSkillReferenceCatalog,
  loadProjectSkillDocuments,
} from '../../src/project-skills/index.js';
import { parseReverseEtlProject } from '../../src/reverse-etl/index.js';
import { findBobsledProject } from '../../src/runner/config/loader.js';
import { listSyncSpecs } from '../../src/sync/index.js';

const PIPELINES = `destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github_issues:
    schedule: daily
    runner: managed
    source: github
    destination: warehouse
    resources: [repos, issues]
  order_marts:
    type: models
    connection: duckdb
    schedule: daily
    models: [stg_orders]
`;

const INTEGRATION = `spec_version: '1'
type: integration
name: duckdb
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: demo.db
`;

const SOURCE = `spec_version: '0.2'
type: source
name: raw_orders
source_type: warehouse_table
connection: duckdb
table: main.raw_orders
schema:
  columns:
    - { name: id, type: INTEGER }
`;

const MODEL = `spec_version: '0.2'
type: model
name: stg_orders
source:
  ref: duckdb.raw_orders
`;

const RESOURCE = `type: resource
integration: github
name: issues
`;

const ACTION = `spec_version: '1'
type: action
transport: webhook
name: notify_contact
integration: custom_webhook
description: Send a contact row to an HTTPS webhook endpoint.
webhook:
  url: https://example.com/bobsled-sync-webhook
  method: POST
input:
  email:
    type: string
    required: true
`;

const SYNC = `spec_version: '1'
type: sync
name: contacts_to_webhook
schedule: daily
source:
  type: projection
  connection: duckdb
  projection_ref: main.contacts
  cursor:
    field: observed_at
    initial_value: '1970-01-01T00:00:00.000Z'
target:
  action: custom_webhook/notify_contact
  entity_key:
    fields: [email]
  input_mapping:
    email: email
`;

const SKILL_BODY = `name: order-review
description: Review order models before a release.
---

# Order review

Check stg_orders before each release.
`;

const GUIDE = `---
description: What the order data means.
---

# Orders

Orders come from DuckDB.
`;

const CONVENTIONAL: Record<string, string> = {
  'bobsled.yml': PIPELINES,
  'integrations/duckdb.yml': INTEGRATION,
  'sources/raw_orders.yml': SOURCE,
  'models/stg_orders.yml': MODEL,
  'resources/github/issues.yml': RESOURCE,
  'actions/notify_contact.yml': ACTION,
  'syncs/contacts_to_webhook.yml': SYNC,
  'skills/order-review/SKILL.md': `---\n${SKILL_BODY}`,
  'AGENTS.md': GUIDE,
};

const DATA_FIRST: Record<string, string> = {
  'settings/pipelines.yml': `type: pipeline_config\n${PIPELINES}`,
  'warehouse/duckdb.yml': INTEGRATION,
  'warehouse/orders/raw_orders.yml': SOURCE,
  'warehouse/orders/stg_orders.yml': MODEL,
  'github/issues.yml': RESOURCE,
  'activation/contacts/notify-contact.yml': ACTION,
  'activation/contacts/sync.yml': SYNC,
  'guides/order-review.md': `---\ntype: skill\n${SKILL_BODY}`,
  'AGENTS.md': GUIDE,
};

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-layout-')));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('conventional and data-first project layouts', () => {
  it('resolves an authored private Blob source and guarded Snowflake table', async () => {
    const root = project({
      'bobsled.yml': `destinations:
  staging:
    auth_env_vars: [SNOWFLAKE_TOKEN]
    type: snowflake
    account: account
    username: loader
    credentials_access_token: $SNOWFLAKE_TOKEN
    warehouse: WH
    database: DB
    schema: STAGING
pipelines:
  upload:
    type: extract
    schedule: manual
    runner: managed
    source: private_upload
    destination: staging
    load_strategy: full_refresh
    resources:
      - resource: uploaded_csv
        table: DS_CSV_ABC123
        table_ownership_marker: dataset-abc123
`,
      'integrations/private_upload.yml': `spec_version: '1'
auth_env_vars: [PRIVATE_UPLOAD_ORIGIN, PRIVATE_UPLOAD_SIGNED_URL]
type: integration
name: private_upload
source_type: vercel_blob
connection:
  blob_ref: attachments/ns/project/attachment
auth:
  type: signed_url_env
  url_env: PRIVATE_UPLOAD_SIGNED_URL
  origin_env: PRIVATE_UPLOAD_ORIGIN
`,
      'resources/private_upload/uploaded_csv.yml': `spec_version: '1'
type: resource
name: uploaded_csv
source:
  path: attachments/ns/project/attachment
  format: csv
replication:
  method: full_refresh
output: {}
`,
    });

    const resolved = await resolveProjectPipelines({ projectRoot: root });
    expect(resolved.extractPipelines[0]?.resources[0]?.override).toMatchObject({
      table: 'DS_CSV_ABC123',
      tableOwnershipMarker: 'dataset-abc123',
    });

    const manifest = await generateProjectManifest({ projectRoot: root, bobsledVersion: 'test' });
    expect(manifest.pipelines[0]?.resource_metadata?.['uploaded_csv']?.load).toMatchObject({
      table: 'DS_CSV_ABC123',
      table_ownership_marker: 'dataset-abc123',
    });
  });

  it('rejects an ownership marker on a non-Snowflake destination', async () => {
    const root = project({
      'bobsled.yml': `destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  upload:
    schedule: manual
    runner: managed
    source: github
    destination: warehouse
    resources:
      - resource: issues
        table: RESERVED
        table_ownership_marker: dataset-1
`,
    });
    await expect(resolveProjectPipelines({ projectRoot: root })).rejects.toThrow(
      'table_ownership_marker requires one supported warehouse destination'
    );
  });

  it('passes inferred model and source types to their existing loaders in memory', async () => {
    const sourceRoot = project({
      'integrations/duckdb.yml': INTEGRATION.replace('type: integration\n', ''),
      'sources/raw_orders.yml': SOURCE.replace('type: source\n', ''),
    });
    const sourceIndex = scanProject(sourceRoot);
    expect(
      sourceIndex.entries.find((entry) => entry.path === 'sources/raw_orders.yml')?.document
    ).toMatchObject({
      type: 'source',
    });
    expect(
      sourceIndex.entries.find((entry) => entry.path === 'integrations/duckdb.yml')?.document
    ).toMatchObject({
      type: 'integration',
    });
    const loadedSources = await loadProject(sourceRoot, { skipEntities: true });
    expect(loadedSources.sourceEntries.has('duckdb.raw_orders')).toBe(true);
    expect(fs.readFileSync(path.join(sourceRoot, 'sources/raw_orders.yml'), 'utf8')).not.toContain(
      'type: source'
    );

    const modelRoot = project({
      ...DATA_FIRST,
      'warehouse/orders/models/stg_orders.yml': MODEL.replace('type: model\n', ''),
    });
    const modelIndex = scanProject(modelRoot);
    expect(
      modelIndex.entries.find((entry) => entry.path === 'warehouse/orders/models/stg_orders.yml')
        ?.document
    ).toMatchObject({ type: 'model' });
    const resolvedModels = await resolveProjectPipelines({ projectRoot: modelRoot });
    expect(resolvedModels.modelPipelines.map((pipeline) => pipeline.models)).toContainEqual([
      'stg_orders',
    ]);
    expect(
      fs.readFileSync(path.join(modelRoot, 'warehouse/orders/models/stg_orders.yml'), 'utf8')
    ).not.toContain('type: model');
  });

  it('locate the pipeline configuration wherever it lives', () => {
    const conventional = project(CONVENTIONAL);
    const dataFirst = project(DATA_FIRST);

    expect(findBobsledProject(conventional)).toEqual({
      projectRoot: conventional,
      configPaths: [path.join(conventional, 'bobsled.yml')],
      index: expect.objectContaining({ root: conventional }),
    });
    expect(findBobsledProject(dataFirst)).toEqual({
      projectRoot: dataFirst,
      configPaths: [path.join(dataFirst, 'settings', 'pipelines.yml')],
      index: expect.objectContaining({ root: dataFirst }),
    });
  });

  it('resolve the same pipelines and manifest', async () => {
    const conventional = await resolveProjectPipelines({ projectRoot: project(CONVENTIONAL) });
    const dataFirst = await resolveProjectPipelines({ projectRoot: project(DATA_FIRST) });

    expect(dataFirst.extractPipelines).toEqual(conventional.extractPipelines);
    expect(dataFirst.modelPipelines).toEqual(conventional.modelPipelines);
    expect(dataFirst.modelPipelines.map((pipeline) => pipeline.models)).toEqual([['stg_orders']]);
    expect(dataFirst.secrets).toEqual(conventional.secrets);
    expect(dataFirst.warnings).toEqual(conventional.warnings);
    expect(conventional.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Project-local overrides bundled')])
    );

    const manifest = async (files: Record<string, string>) =>
      generateProjectManifest({ projectRoot: project(files), bobsledVersion: '0.0.0-test' });
    expect(await manifest(DATA_FIRST)).toEqual(await manifest(CONVENTIONAL));
  });

  it('load the same syncs, actions, Skills, and Skill references', async () => {
    const conventional = project(CONVENTIONAL);
    const dataFirst = project(DATA_FIRST);

    const reverseEtl = (root: string) => {
      const parsed = parseReverseEtlProject(root);
      expect(parsed.errors).toEqual([]);
      return {
        syncs: parsed.syncs.map((sync) => sync.spec),
        actions: parsed.actions.map((action) => [action.qualifiedName, action.spec]),
      };
    };
    expect(reverseEtl(dataFirst)).toEqual(reverseEtl(conventional));
    expect(listSyncSpecs(dataFirst).map((sync) => sync.name)).toEqual(['contacts_to_webhook']);

    const skills = (root: string) =>
      loadProjectSkillDocuments(root).skills.map(({ name, description, content }) => ({
        name,
        description,
        content,
      }));
    expect(skills(dataFirst)).toEqual(skills(conventional));
    expect(skills(dataFirst).map((skill) => skill.name)).toEqual(['order-review']);

    const references = async (root: string) =>
      (await buildProjectSkillReferenceCatalog(root)).names;
    const dataFirstReferences = await references(dataFirst);
    expect(dataFirstReferences).toEqual(await references(conventional));
    expect(dataFirstReferences.model).toContain('stg_orders');
    expect(dataFirstReferences.resource).toContain('github/issues');
    expect(dataFirstReferences.action).toContain('custom_webhook/notify_contact');
  });
});

describe('project files that cannot be loaded', () => {
  it('names both files of a duplicated sync', () => {
    const root = project({
      ...DATA_FIRST,
      'activation/other/sync.yml': SYNC,
    });

    expect(() => listSyncSpecs(root)).toThrow(ProjectIndexError);
    expect(() => listSyncSpecs(root)).toThrow(
      /activation\/contacts\/sync\.yml and activation\/other\/sync\.yml/
    );
  });

  it('names both files of a duplicated action', () => {
    const root = project({
      ...DATA_FIRST,
      'crm/notify.yml': ACTION,
    });

    const parsed = parseReverseEtlProject(root);
    expect(parsed.errors.map((error) => error.message).join('\n')).toMatch(
      /custom_webhook\/notify_contact" is defined multiple times: .*activation\/contacts\/notify-contact\.yml, .*crm\/notify\.yml/
    );
  });

  it('names both files of a duplicated resource', async () => {
    const root = project({
      ...DATA_FIRST,
      'resources/github/issues.yml': RESOURCE,
    });

    await expect(resolveProjectPipelines({ projectRoot: root })).rejects.toThrow(
      /Duplicate resource "github\/issues" in github\/issues\.yml and resources\/github\/issues\.yml/
    );
  });

  it('rejects duplicate pipelines across root and nested fragments with both owners', async () => {
    const root = project({ ...DATA_FIRST, 'bobsled.yml': PIPELINES });

    await expect(resolveProjectPipelines({ projectRoot: root })).rejects.toThrow(
      /Duplicate pipeline "github_issues" is declared in both bobsled\.yml and settings\/pipelines\.yml/
    );
  });

  it('reports ambiguous sources, unknown types, and malformed YAML by path', () => {
    const index = scanProject(
      project({
        ...DATA_FIRST,
        'warehouse/mystery.yml': 'type: source\nname: mystery\n',
        'warehouse/typo.yml': 'type: modle\nname: typo\n',
        'warehouse/broken.yml': 'type: model\nname: [unclosed\n',
      })
    );

    expect(index.issues).toEqual([
      expect.objectContaining({ path: 'warehouse/broken.yml', code: 'invalid_yaml' }),
      expect.objectContaining({ path: 'warehouse/mystery.yml', code: 'ambiguous_source' }),
      expect.objectContaining({ path: 'warehouse/typo.yml', code: 'unknown_type' }),
    ]);
  });

  it('reports a model pipeline naming a model no file declares', async () => {
    const root = project({
      ...DATA_FIRST,
      'warehouse/orders/stg_orders.yml': MODEL.replace('stg_orders', 'stg_orders_v2'),
    });

    const error = await resolveProjectPipelines({ projectRoot: root }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(BobsledProjectValidationError);
    expect((error as BobsledProjectValidationError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'settings/pipelines.yml:pipelines.order_marts.models',
          filePath: 'settings/pipelines.yml',
          fieldPath: 'pipelines.order_marts.models',
          message:
            'Model "stg_orders" not found as a derived model in the project (no type: model file declares that name).',
        }),
      ])
    );
  });
});
