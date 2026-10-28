import { describe, expect, it } from 'vitest';

import {
  analyzeEntitySchema,
  detectEntityType,
  detectIdFields,
  suggestStandardizeRules,
} from '../../../../src/compiler/identity/entity-detection.js';

describe('entity-detection', () => {
  it('detects company schemas from domain and company-name signals', () => {
    const schema = {
      name: 'accounts',
      columns: [
        { name: 'account_id', type: 'VARCHAR' },
        { name: 'company_name', type: 'VARCHAR' },
        { name: 'domain', type: 'VARCHAR' },
      ],
    };

    expect(detectEntityType(schema)).toBe('account');
    expect(detectIdFields(schema)).toEqual(['account_id']);
  });

  it('detects person schemas from email and name signals', () => {
    const schema = {
      name: 'contacts',
      columns: [
        { name: 'contact_id', type: 'VARCHAR' },
        { name: 'first_name', type: 'VARCHAR' },
        { name: 'last_name', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
      ],
    };

    const analysis = analyzeEntitySchema(schema);
    expect(analysis.entityType).toBe('contact');
    expect(analysis.confidence).toBeGreaterThan(0.7);
  });

  it('handles irregular plural resource names when inferring id fields', () => {
    const schema = {
      name: 'children',
      columns: [
        { name: 'child_id', type: 'VARCHAR' },
        { name: 'parent_id', type: 'VARCHAR' },
      ],
    };

    expect(detectIdFields(schema)).toEqual(['child_id']);
  });

  it('does not auto-promote foreign-key looking columns into id_fields', () => {
    const analysis = analyzeEntitySchema({
      name: 'contacts',
      columns: [
        { name: 'contact_id', type: 'VARCHAR' },
        { name: 'company_id', type: 'VARCHAR' },
        { name: 'owner_id', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
      ],
    });

    expect(analysis.idFields).toEqual(['contact_id']);
    expect(
      analysis.reviewMarkers.some(
        (marker) => marker.includes('company_id') && marker.includes('owner_id')
      )
    ).toBe(true);
  });

  it('emits review markers for ambiguous mixed schemas', () => {
    const analysis = analyzeEntitySchema({
      name: 'customers',
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'first_name', type: 'VARCHAR' },
        { name: 'company_name', type: 'VARCHAR' },
      ],
    });

    expect(analysis.entityType).toBe('unknown');
    expect(analysis.reviewMarkers.some((marker) => marker.includes('confirm'))).toBe(true);
  });

  it('suggests standardize transforms for domain, email, and company fields', () => {
    const rules = suggestStandardizeRules(['company_name', 'domain', 'email'], 'company');

    expect(rules).toEqual(
      expect.arrayContaining([
        {
          field: 'company_name',
          transforms: ['strip_legal_suffixes', 'lowercase', 'collapse_whitespace'],
        },
        {
          field: 'domain',
          transforms: ['strip_www', 'strip_protocol', 'lowercase'],
        },
        {
          field: 'email',
          transforms: ['lowercase', 'trim'],
        },
      ])
    );
  });
});
