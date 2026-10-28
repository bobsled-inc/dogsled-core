import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { scaffoldResolutionSpec } from '../../../../src/compiler/identity/scaffold.js';

describe('scaffoldResolutionSpec', () => {
  it('builds a company scaffold with review comments and blocking defaults', () => {
    const yaml = scaffoldResolutionSpec(
      'company',
      'company',
      {
        nameFields: ['company_name'],
        domainField: 'domain',
        phoneField: 'phone',
        reviewMarkers: ['REVIEW: confirm the primary blocking key'],
      },
      [
        {
          ref: 'crm.company_accounts',
          trustTier: 'gold',
          idFields: ['account_id'],
        },
      ]
    );

    expect(yaml).toContain('name: company_resolution');
    expect(yaml).toContain('field: company_name');
    expect(yaml).toContain('key: standardized_domain');
    expect(yaml).toContain('# REVIEW: confirm the primary blocking key');
    expect(yaml).toContain('# REVIEW: Validate thresholds against your dataset');
  });

  it('adds deterministic email matching for person scaffolds', () => {
    const yaml = scaffoldResolutionSpec(
      'person',
      'person',
      {
        nameFields: ['first_name', 'last_name'],
        emailField: 'email',
      },
      [
        {
          ref: 'crm.contacts',
          trustTier: 'silver',
          idFields: ['contact_id'],
        },
      ]
    );

    expect(yaml).toContain('name: person_resolution');
    expect(yaml).toContain('name: email_exact_match');
    expect(yaml).toContain('field: email');
    expect(yaml).toContain('confidence: 1');
  });

  it('uses the concrete entity name for generated specs', () => {
    const yaml = scaffoldResolutionSpec(
      'company_accounts',
      'company',
      {
        nameFields: ['company_name'],
      },
      [{ ref: 'crm.company_accounts' }]
    );

    expect(yaml).toContain('name: company_accounts_resolution');
  });

  it('merges fallback standardizers when inferred suggestions are partial', () => {
    const yaml = scaffoldResolutionSpec(
      'company',
      'company',
      {
        nameFields: ['company_name'],
        domainField: 'domain',
        standardizeRules: [
          {
            field: 'domain',
            transforms: ['strip_protocol', 'lowercase'],
          },
        ],
      },
      [{ ref: 'crm.company_accounts' }]
    );
    const parsed = YAML.parse(yaml) as { standardize?: Array<{ field: string }> };

    expect(parsed.standardize).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'domain' }),
        expect.objectContaining({ field: 'company_name' }),
      ])
    );
  });

  it('defaults missing id_fields to id and leaves a review marker', () => {
    const yaml = scaffoldResolutionSpec(
      'company',
      'company',
      {
        nameFields: ['company_name'],
      },
      [{ ref: 'crm.company_accounts' }]
    );
    const parsed = YAML.parse(yaml) as {
      inputs?: Array<{ id_fields?: string[] }>;
    };

    expect(parsed.inputs?.[0]?.id_fields).toEqual(['id']);
    expect(yaml).toContain('REVIEW: No id_fields were detected for crm.company_accounts');
  });

  it('adds the missing-email review note to person scaffolds without deterministic rules', () => {
    const yaml = scaffoldResolutionSpec(
      'person',
      'person',
      {
        nameFields: ['first_name', 'last_name'],
      },
      [{ ref: 'crm.contacts', idFields: ['contact_id'] }]
    );

    expect(yaml).toContain(
      'REVIEW: No email field was detected, so the deterministic email_exact_match rule was skipped.'
    );
    expect(yaml).not.toContain('name: email_exact_match');
  });

  it('uses real fallback fields instead of emitting standardized_name placeholders', () => {
    const yaml = scaffoldResolutionSpec(
      'company',
      'company',
      {
        nameFields: [],
        phoneField: 'phone',
      },
      [{ ref: 'crm.company_accounts' }]
    );

    expect(yaml).toContain('standardized_phone');
    expect(yaml).not.toContain('standardized_name');
  });

  it('fails fast when the scaffold entity type remains unknown', () => {
    expect(() =>
      scaffoldResolutionSpec(
        'custom_entity',
        'unknown',
        {
          nameFields: ['display_name'],
        },
        [{ ref: 'crm.custom_entities', idFields: ['custom_id'] }]
      )
    ).toThrow('Cannot scaffold a resolution spec for an unknown entity type');
  });
});
