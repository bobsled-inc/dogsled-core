import { describe, expect, it } from 'vitest';

import { mapFields } from '../../src/runtime/activate/field-mapper.js';
import { ExtractorDataError } from '../../src/runtime/errors.js';

describe('mapFields', () => {
  it('maps direct and transformed fields', () => {
    const mapped = mapFields(
      {
        fields: {
          first_name: 'first_name',
          amount: {
            source: 'amount',
            transform: 'to_string',
          },
        },
        unmapped_fields: 'ignore',
      },
      {
        first_name: 'Alice',
        amount: 42,
      }
    );

    expect(mapped).toEqual({
      first_name: 'Alice',
      amount: '42',
    });
  });

  it('passes through unused fields when configured', () => {
    const mapped = mapFields(
      {
        fields: {
          email: 'email',
        },
        unmapped_fields: 'passthrough',
      },
      {
        email: 'alice@example.com',
        team: 'sales',
      }
    );

    expect(mapped).toEqual({
      email: 'alice@example.com',
      team: 'sales',
    });
  });

  it('uses sparse undefined values for missing optional fields and defaults for fallbacks', () => {
    const mapped = mapFields(
      {
        fields: {
          title: 'title',
          stage: {
            source: 'stage',
            default: 'lead',
          },
        },
        unmapped_fields: 'ignore',
      },
      {}
    );

    expect(mapped).toEqual({
      title: undefined,
      stage: 'lead',
    });
  });

  it('stringifies missing optional values when to_string is requested', () => {
    const mapped = mapFields(
      {
        fields: {
          phone: {
            source: 'phone',
            transform: 'to_string',
          },
        },
        unmapped_fields: 'ignore',
      },
      {}
    );

    expect(mapped).toEqual({
      phone: undefined,
    });
  });

  it('stringifies defaulted optional values when to_string is requested', () => {
    const mapped = mapFields(
      {
        fields: {
          phone: {
            source: 'phone',
            transform: 'to_string',
            default: 42,
          },
        },
        unmapped_fields: 'ignore',
      },
      {}
    );

    expect(mapped).toEqual({
      phone: '42',
    });
  });

  it('throws when required mapped fields are missing', () => {
    expect(() =>
      mapFields(
        {
          fields: {
            email: {
              source: 'email',
              required: true,
            },
          },
          unmapped_fields: 'ignore',
        },
        {}
      )
    ).toThrow(ExtractorDataError);
  });

  it('throws when unmapped_fields is error and the record contains extra keys', () => {
    expect(() =>
      mapFields(
        {
          fields: {
            email: 'email',
          },
          unmapped_fields: 'error',
        },
        {
          email: 'alice@example.com',
          extra: true,
        }
      )
    ).toThrow(ExtractorDataError);
  });
});
