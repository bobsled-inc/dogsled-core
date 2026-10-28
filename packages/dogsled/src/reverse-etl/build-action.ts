/**
 * In-memory reverse-ETL `Action` builders.
 *
 * Managed reverse-ETL (DB-driven, no `syncs/*.yml` / `actions/*.yml` on disk)
 * cannot use the disk parser (`parseReverseEtlProject`) or
 * `resolveAction(spec, projectRoot)`. These helpers assemble the same Dogsled
 * `Action` objects from in-memory inputs so a host application's
 * managed destination flow can stop hand-rolling the shapes.
 *
 * Boundary safety: this module is a *clean leaf*. It imports only the
 * schema-only `@bobsled-inc/extractor/extractor` barrel (for `ActionSpecSchema`)
 * plus type-only symbols — it has zero static path to execution/runtime code,
 * and therefore none to the DuckDB native binding `@duckdb/node-api`. It is
 * re-exported from the boundary-safe `@bobsled-inc/dogsled/schema` entry so
 * config-only consumers (Next.js/Vercel routes lacking `libduckdb`) can import
 * the builders without dlopen'ing DuckDB. See
 * `tests/unit/reverse-etl-build-action-import-safety.test.ts`.
 */

import { join } from 'node:path';

import { ActionSpecSchema } from '@bobsled-inc/extractor/extractor';

import type { InputFieldDefinition } from '@bobsled-inc/extractor/core';
import type { ActionSpec } from '@bobsled-inc/extractor/extractor';
import type { Action } from '@bobsled-inc/integrations/actions';

/** The external-id input every reverse-ETL action receives so the sync runtime
 * can address the destination record. */
const EXTERNAL_ID_INPUT: InputFieldDefinition = { type: 'string', required: true };

const DEFAULT_REVERSE_ETL_TAGS = ['custom-api', 'reverse-etl'] as const;

export interface BuildReverseEtlActionOptions {
  /** Integration slug the action is attached to (becomes `Action.integration`
   * and the `<integration>/` prefix of `qualifiedName`). */
  integrationName: string;
  /** Project root used to synthesize the `actions/` filePath. Defaults to `.`
   * (managed callers never read the file; the path is identity metadata). */
  projectRoot?: string;
  /** Inject the required `external_id` input. Defaults to `true`. */
  requireExternalId?: boolean;
}

/**
 * Build a Dogsled `Action` from a user-authored `ActionSpec` template plus an
 * integration slug — the in-memory equivalent of resolving an action off disk.
 *
 * Mirrors the app's `buildActionFromSpec` / `buildRestAction`:
 *   1. `structuredClone` the spec (never mutate the caller's template),
 *   2. stamp `spec.integration = integrationName`,
 *   3. inject the required `external_id` input (unless `requireExternalId` is
 *      `false`),
 *   4. assemble the `Action` registry shape.
 *
 * Integration-specific quirks (e.g. Notion's create_page optional-property
 * pruning) stay with the caller; compose {@link pruneUnmappedOptionalInputs}
 * for the integration-agnostic part.
 */
export function buildReverseEtlActionFromSpec(
  spec: ActionSpec,
  opts: BuildReverseEtlActionOptions
): Action {
  const { integrationName, projectRoot = '.', requireExternalId = true } = opts;

  const cloned = structuredClone(spec);
  cloned.integration = integrationName;
  if (requireExternalId) {
    cloned.input = { ...cloned.input, external_id: { ...EXTERNAL_ID_INPUT } };
  }

  return {
    name: cloned.name,
    qualifiedName: `${integrationName}/${cloned.name}`,
    integration: integrationName,
    // Mirror the spec transport so executeAction routes correctly (api today;
    // webhook templates resolve to webhook).
    transport: cloned.transport,
    tags: cloned.tags ?? [...DEFAULT_REVERSE_ETL_TAGS],
    description: cloned.description,
    inputs: cloned.input,
    spec: cloned,
    filePath: join(projectRoot, 'actions', `${integrationName}_${cloned.name}.yml`),
  };
}

export interface BuildSalesforceUpsertActionOptions {
  /** Salesforce REST API version segment, e.g. `v59.0`. */
  apiVersion: string;
  /** Target sObject API name, e.g. `Account`. */
  sObject: string;
  /** External-id field used for the upsert key, e.g. `External_Id__c`. */
  externalIdField: string;
  /** Destination field names mapped from the source projection. */
  mappedFields: string[];
  /** Integration slug. Defaults to `salesforce`. */
  integrationName?: string;
  /** Project root used to synthesize the `actions/` filePath. Defaults to `.`. */
  projectRoot?: string;
}

/**
 * Build the canonical managed Salesforce upsert `Action`.
 *
 * Produces the canonical Salesforce-upsert `ActionSpec` template
 * (`<integration>/upsert_sobject`): a `PATCH` to the sObject's external-id
 * endpoint with the mapped record as the request body, upsert activation keyed
 * by `external_id`, and retry-on-error handling. The embedded spec is validated
 * against `ActionSpecSchema` so it always matches what the disk parser accepts.
 */
export function buildSalesforceUpsertAction(opts: BuildSalesforceUpsertActionOptions): Action {
  const { apiVersion, sObject, externalIdField, mappedFields } = opts;
  const integration = opts.integrationName ?? 'salesforce';
  const projectRoot = opts.projectRoot ?? '.';
  const name = 'upsert_sobject';
  const tags = ['salesforce', 'reverse-etl'];

  const input: Record<string, InputFieldDefinition> = {
    external_id: { ...EXTERNAL_ID_INPUT },
  };
  const fields: Record<string, string> = {};
  for (const field of mappedFields) {
    // external_id is the reserved upsert key (URL path + activate identity),
    // never a mapped body field — don't let it overwrite the required input.
    if (field === 'external_id') {
      continue;
    }
    input[field] = { type: 'string' };
    fields[field] = field;
  }

  // Validate-and-canonicalize: the literal below is the source of truth, and
  // parsing guarantees it stays a schema-valid ActionSpec (identical to what
  // `loadActions` would produce off disk).
  const spec = ActionSpecSchema.parse({
    type: 'action',
    name,
    integration,
    tags,
    description: `Upsert a record into the Salesforce ${sObject} object keyed by ${externalIdField}.`,
    transport: 'api',
    api: {
      endpoint: `/services/data/${apiVersion}/sobjects/${sObject}/${externalIdField}/\${{ input.external_id }}`,
      method: 'PATCH',
      request_body: '${{ mapped }}',
    },
    field_mapping: {
      fields,
      unmapped_fields: 'ignore',
    },
    activate: {
      operation: 'upsert',
      identity: { fields: ['external_id'], strategy: 'external_id' },
      result_path: '$.id',
    },
    error_handling: {
      on_record_error: 'retry',
      consecutive_failure_threshold: 3,
      max_retries: 3,
    },
    input,
  });

  return {
    name,
    qualifiedName: `${integration}/${name}`,
    integration,
    transport: 'api',
    tags,
    description: spec.description,
    inputs: spec.input,
    spec,
    filePath: join(projectRoot, 'actions', `${integration}_${name}.yml`),
  };
}

/**
 * Drop optional, unmapped inputs from a reverse-ETL `ActionSpec`.
 *
 * Generic, integration-agnostic helper: removes every `input` entry that is
 * neither required nor present in `mappedInputs`, and the matching
 * `field_mapping.fields` entry (api transport only). Required inputs (e.g. the
 * injected `external_id`), mapped inputs, and `activate.identity` fields are
 * always kept, so the result stays a valid `ActionSpec`.
 *
 * Integration-specific request-body pruning (e.g. Notion's
 * `api.request_body.properties`, which is keyed by destination property name
 * rather than input name and filtered by property type) stays with the caller —
 * compose this helper for the input/field-mapping part and prune the body
 * separately.
 */
export function pruneUnmappedOptionalInputs(
  spec: ActionSpec,
  mappedInputs: Iterable<string>
): ActionSpec {
  const mapped = new Set(mappedInputs);
  const cloned = structuredClone(spec);

  const dropped = new Set<string>();
  for (const [key, field] of Object.entries(cloned.input)) {
    if (field.required !== true && !mapped.has(key)) {
      dropped.add(key);
    }
  }

  // Never drop an input the activate config depends on, even if it is optional
  // and unmapped — doing so would yield a spec that no longer validates against
  // ActionSpecSchema (identity fields must exist in input or field_mapping).
  if (cloned.transport === 'api' && cloned.activate.operation !== 'create') {
    for (const identityField of cloned.activate.identity.fields) {
      dropped.delete(identityField);
    }
  }

  if (dropped.size === 0) {
    return cloned;
  }

  cloned.input = Object.fromEntries(
    Object.entries(cloned.input).filter(([key]) => !dropped.has(key))
  );
  if (cloned.transport === 'api') {
    cloned.field_mapping.fields = Object.fromEntries(
      Object.entries(cloned.field_mapping.fields).filter(([key]) => !dropped.has(key))
    );
  }

  return cloned;
}
