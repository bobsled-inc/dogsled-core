import { ActionSpecSchema } from '@bobsled-inc/extractor/extractor';
import { describe, expect, it } from 'vitest';

import {
  buildReverseEtlActionFromSpec,
  buildSalesforceUpsertAction,
  pruneUnmappedOptionalInputs,
} from '../../../src/reverse-etl/build-action.js';

import type { ActionSpec } from '@bobsled-inc/extractor/extractor';

function makeApiSpec(): ActionSpec {
  return ActionSpecSchema.parse({
    type: 'action',
    name: 'create_widget',
    integration: 'placeholder',
    tags: ['existing-tag'],
    description: 'Create a widget.',
    transport: 'api',
    api: {
      endpoint: '/widgets',
      method: 'POST',
      request_body: { name: '${{ mapped.name }}' },
    },
    field_mapping: { fields: { name: 'name' }, unmapped_fields: 'ignore' },
    activate: { operation: 'create', result_path: '$.id' },
    input: {
      name: { type: 'string', required: true },
    },
  });
}

describe('buildReverseEtlActionFromSpec', () => {
  it('clones the template, stamps the integration, and injects external_id', () => {
    const spec = makeApiSpec();
    const action = buildReverseEtlActionFromSpec(spec, { integrationName: 'acme' });

    expect(action.name).toBe('create_widget');
    expect(action.qualifiedName).toBe('acme/create_widget');
    expect(action.integration).toBe('acme');
    expect(action.transport).toBe('api');
    expect(action.tags).toEqual(['existing-tag']);
    expect(action.description).toBe('Create a widget.');
    expect(action.filePath).toBe('actions/acme_create_widget.yml');

    expect(action.inputs.external_id).toEqual({ type: 'string', required: true });
    expect(action.inputs.name).toEqual({ type: 'string', required: true });
    expect(action.spec.integration).toBe('acme');
    expect(action.spec.input.external_id).toEqual({ type: 'string', required: true });
    // The assembled inputs are the (mutated) spec input.
    expect(action.inputs).toBe(action.spec.input);
  });

  it('does not mutate the caller-provided template', () => {
    const spec = makeApiSpec();
    buildReverseEtlActionFromSpec(spec, { integrationName: 'acme' });

    expect(spec.integration).toBe('placeholder');
    expect(Object.hasOwn(spec.input, 'external_id')).toBe(false);
  });

  it('honors an explicit projectRoot', () => {
    const action = buildReverseEtlActionFromSpec(makeApiSpec(), {
      integrationName: 'acme',
      projectRoot: '/proj',
    });
    expect(action.filePath).toBe('/proj/actions/acme_create_widget.yml');
  });

  it('skips external_id injection when requireExternalId is false', () => {
    const action = buildReverseEtlActionFromSpec(makeApiSpec(), {
      integrationName: 'acme',
      requireExternalId: false,
    });
    expect(Object.hasOwn(action.inputs, 'external_id')).toBe(false);
    expect(Object.hasOwn(action.spec.input, 'external_id')).toBe(false);
  });

  it('normalizes a pre-existing external_id input to the required string shape', () => {
    const spec = ActionSpecSchema.parse({
      type: 'action',
      name: 'create_widget',
      integration: 'placeholder',
      description: 'Create a widget.',
      transport: 'api',
      api: { endpoint: '/widgets', method: 'POST', request_body: { id: '${{ mapped.id }}' } },
      field_mapping: { fields: { id: 'id' }, unmapped_fields: 'ignore' },
      activate: { operation: 'create', result_path: '$.id' },
      input: { external_id: { type: 'number', description: 'stale shape' } },
    });
    const action = buildReverseEtlActionFromSpec(spec, { integrationName: 'acme' });
    expect(action.inputs.external_id).toEqual({ type: 'string', required: true });
  });

  it('preserves an empty tag list from a schema-parsed template', () => {
    // Real callers always get specs through ActionSpecSchema, which defaults
    // `tags` to []. Per §1 (`tags: spec.tags ?? [...]`) an empty array is not
    // nullish, so it is preserved as-is — the default-tags branch does not fire.
    const spec = ActionSpecSchema.parse({
      type: 'action',
      name: 'create_widget',
      integration: 'placeholder',
      description: 'Create a widget.',
      transport: 'api',
      api: { endpoint: '/widgets', method: 'POST', request_body: { name: '${{ mapped.name }}' } },
      field_mapping: { fields: { name: 'name' }, unmapped_fields: 'ignore' },
      activate: { operation: 'create', result_path: '$.id' },
      input: { name: { type: 'string', required: true } },
    });
    expect(spec.tags).toEqual([]);
    const action = buildReverseEtlActionFromSpec(spec, { integrationName: 'acme' });
    expect(action.tags).toEqual([]);
  });

  it('applies default reverse-ETL tags only when a raw template omits tags entirely', () => {
    // Defensive `?? ['custom-api','reverse-etl']` branch: fires for raw/non-schema
    // templates whose `tags` is genuinely absent (undefined), not for parsed specs.
    const raw = { ...makeApiSpec(), tags: undefined } as unknown as ActionSpec;
    const action = buildReverseEtlActionFromSpec(raw, { integrationName: 'acme' });
    expect(action.tags).toEqual(['custom-api', 'reverse-etl']);
  });

  it('mirrors the transport of a webhook template', () => {
    const webhookSpec = ActionSpecSchema.parse({
      type: 'action',
      name: 'notify',
      integration: 'placeholder',
      description: 'Notify a webhook.',
      transport: 'webhook',
      webhook: {
        url: 'https://example.com/hook',
        method: 'POST',
        request_body: { id: '${{ mapped.id }}' },
      },
      input: { id: { type: 'string', required: true } },
    });
    const action = buildReverseEtlActionFromSpec(webhookSpec, { integrationName: 'acme' });
    expect(action.transport).toBe('webhook');
    expect(action.qualifiedName).toBe('acme/notify');
    expect(action.inputs.external_id).toEqual({ type: 'string', required: true });
  });
});

describe('buildSalesforceUpsertAction', () => {
  it('produces the canonical Salesforce upsert action', () => {
    const action = buildSalesforceUpsertAction({
      apiVersion: 'v59.0',
      sObject: 'Account',
      externalIdField: 'External_Id__c',
      mappedFields: ['name', 'industry'],
    });

    expect(action.name).toBe('upsert_sobject');
    expect(action.qualifiedName).toBe('salesforce/upsert_sobject');
    expect(action.integration).toBe('salesforce');
    expect(action.transport).toBe('api');
    expect(action.tags).toEqual(['salesforce', 'reverse-etl']);
    expect(action.filePath).toBe('actions/salesforce_upsert_sobject.yml');
    expect(action.inputs).toBe(action.spec.input);

    const spec = action.spec;
    expect(spec.transport).toBe('api');
    if (spec.transport !== 'api') throw new Error('expected api transport');

    expect(spec.api.endpoint).toBe(
      '/services/data/v59.0/sobjects/Account/External_Id__c/${{ input.external_id }}'
    );
    expect(spec.api.method).toBe('PATCH');
    expect(spec.api.request_body).toBe('${{ mapped }}');

    expect(spec.field_mapping).toEqual({
      fields: { name: 'name', industry: 'industry' },
      unmapped_fields: 'ignore',
    });
    expect(spec.activate).toEqual({
      operation: 'upsert',
      identity: { fields: ['external_id'], strategy: 'external_id' },
      result_path: '$.id',
    });
    expect(spec.error_handling).toEqual({
      on_record_error: 'retry',
      consecutive_failure_threshold: 3,
      max_retries: 3,
    });

    expect(spec.input.external_id).toEqual({ type: 'string', required: true });
    expect(spec.input.name).toEqual({ type: 'string' });
    expect(spec.input.industry).toEqual({ type: 'string' });
  });

  it('produces a spec that re-validates against ActionSpecSchema', () => {
    const action = buildSalesforceUpsertAction({
      apiVersion: 'v59.0',
      sObject: 'Account',
      externalIdField: 'External_Id__c',
      mappedFields: ['name'],
    });
    expect(ActionSpecSchema.safeParse(action.spec).success).toBe(true);
  });

  it('supports zero mapped fields (external_id only)', () => {
    const action = buildSalesforceUpsertAction({
      apiVersion: 'v59.0',
      sObject: 'Lead',
      externalIdField: 'Ext__c',
      mappedFields: [],
    });
    const spec = action.spec;
    if (spec.transport !== 'api') throw new Error('expected api transport');
    expect(spec.field_mapping.fields).toEqual({});
    expect(Object.keys(action.inputs)).toEqual(['external_id']);
    expect(ActionSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('treats external_id as reserved even when listed in mappedFields', () => {
    const action = buildSalesforceUpsertAction({
      apiVersion: 'v59.0',
      sObject: 'Account',
      externalIdField: 'External_Id__c',
      mappedFields: ['external_id', 'name'],
    });
    // The required upsert key is never downgraded to an optional mapped field.
    expect(action.inputs.external_id).toEqual({ type: 'string', required: true });
    const spec = action.spec;
    if (spec.transport !== 'api') throw new Error('expected api transport');
    // external_id stays the URL/identity key, not a request-body field mapping.
    expect(Object.hasOwn(spec.field_mapping.fields, 'external_id')).toBe(false);
    expect(spec.field_mapping.fields.name).toBe('name');
    expect(ActionSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('honors integrationName and projectRoot overrides', () => {
    const action = buildSalesforceUpsertAction({
      apiVersion: 'v60.0',
      sObject: 'Account',
      externalIdField: 'Ext__c',
      mappedFields: ['name'],
      integrationName: 'sfdc',
      projectRoot: '/proj',
    });
    expect(action.integration).toBe('sfdc');
    expect(action.qualifiedName).toBe('sfdc/upsert_sobject');
    expect(action.filePath).toBe('/proj/actions/sfdc_upsert_sobject.yml');
  });
});

describe('pruneUnmappedOptionalInputs', () => {
  function makePrunableSpec(): ActionSpec {
    return ActionSpecSchema.parse({
      type: 'action',
      name: 'upsert_sobject',
      integration: 'salesforce',
      description: 'Upsert.',
      transport: 'api',
      api: {
        endpoint: '/x/${{ input.external_id }}',
        method: 'PATCH',
        request_body: '${{ mapped }}',
      },
      field_mapping: {
        fields: { keep_me: 'keep_me', drop_me: 'drop_me', required_extra: 'required_extra' },
        unmapped_fields: 'ignore',
      },
      activate: {
        operation: 'upsert',
        identity: { fields: ['external_id'], strategy: 'external_id' },
        result_path: '$.id',
      },
      input: {
        external_id: { type: 'string', required: true },
        keep_me: { type: 'string' },
        drop_me: { type: 'string' },
        required_extra: { type: 'string', required: true },
      },
    });
  }

  it('drops optional unmapped inputs from input and field_mapping.fields', () => {
    const spec = makePrunableSpec();
    const pruned = pruneUnmappedOptionalInputs(spec, ['keep_me']);

    expect(Object.keys(pruned.input).sort()).toEqual(['external_id', 'keep_me', 'required_extra']);
    if (pruned.transport !== 'api') throw new Error('expected api transport');
    expect(Object.keys(pruned.field_mapping.fields).sort()).toEqual(['keep_me', 'required_extra']);
  });

  it('does not mutate the input spec', () => {
    const spec = makePrunableSpec();
    pruneUnmappedOptionalInputs(spec, ['keep_me']);
    expect(Object.hasOwn(spec.input, 'drop_me')).toBe(true);
    if (spec.transport !== 'api') throw new Error('expected api transport');
    expect(Object.hasOwn(spec.field_mapping.fields, 'drop_me')).toBe(true);
  });

  it('never drops an activate.identity field, keeping the spec valid', () => {
    const spec = ActionSpecSchema.parse({
      type: 'action',
      name: 'upsert_thing',
      integration: 'custom_api',
      description: 'Upsert.',
      transport: 'api',
      api: {
        endpoint: '/things/${{ input.tenant_key }}',
        method: 'PATCH',
        request_body: '${{ mapped }}',
      },
      field_mapping: {
        fields: { tenant_key: 'tenant_key', other: 'other' },
        unmapped_fields: 'ignore',
      },
      activate: {
        operation: 'upsert',
        // tenant_key is an optional, unmapped input that the identity depends on.
        identity: { fields: ['tenant_key'], strategy: 'external_id' },
        result_path: '$.id',
      },
      input: {
        tenant_key: { type: 'string' },
        other: { type: 'string' },
      },
    });

    const pruned = pruneUnmappedOptionalInputs(spec, []);
    expect(Object.hasOwn(pruned.input, 'tenant_key')).toBe(true);
    if (pruned.transport !== 'api') throw new Error('expected api transport');
    expect(Object.hasOwn(pruned.field_mapping.fields, 'tenant_key')).toBe(true);
    expect(Object.hasOwn(pruned.input, 'other')).toBe(false);
    expect(ActionSpecSchema.safeParse(pruned).success).toBe(true);
  });

  it('keeps required inputs even when unmapped', () => {
    const spec = makePrunableSpec();
    const pruned = pruneUnmappedOptionalInputs(spec, []);
    expect(Object.hasOwn(pruned.input, 'external_id')).toBe(true);
    expect(Object.hasOwn(pruned.input, 'required_extra')).toBe(true);
    expect(Object.hasOwn(pruned.input, 'keep_me')).toBe(false);
  });

  it('prunes webhook specs without touching a field mapping', () => {
    const spec = ActionSpecSchema.parse({
      type: 'action',
      name: 'notify',
      integration: 'custom_webhook',
      description: 'Notify.',
      transport: 'webhook',
      webhook: { url: 'https://example.com/hook', method: 'POST' },
      input: {
        external_id: { type: 'string', required: true },
        optional_one: { type: 'string' },
      },
    });
    const pruned = pruneUnmappedOptionalInputs(spec, []);
    expect(Object.keys(pruned.input)).toEqual(['external_id']);
    expect(pruned.transport).toBe('webhook');
  });
});
