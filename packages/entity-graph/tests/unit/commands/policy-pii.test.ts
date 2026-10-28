import { describe, expect, it } from 'vitest';

import { resolvePiiRedactFields } from '../../../src/compiler/policy/enforce.js';
import { collectAutoDetectedPiiFields } from '../../../src/commands/policy.js';

import type { ResolvedResolutionSpec } from '../../../src/compiler/identity/types.js';

describe('policy PII auto-detected fields', () => {
  it('feeds Model Spec pii source metadata into policy redaction when policy has no explicit list', () => {
    const fields = collectAutoDetectedPiiFields([
      {
        name: 'person_resolution',
        entity: 'person',
        description: 'Resolve people.',
        inputs: [
          {
            ref: 'crm.contacts',
            fqTableName: '"RAW"."CONTACTS"',
            alias: 's0',
            idFields: ['id'],
            sourceFieldMetadata: {
              email: { name: 'email', type: 'string', pii: true },
              company: { name: 'company', type: 'string', pii: false },
            },
          },
        ],
        standardize: [],
        deterministicRules: [],
        thresholds: { autoMerge: 0.95, review: 0.6, autoReject: 0.4 },
        entityIdPolicy: {
          strategy: 'stable',
          newId: 'component_id',
          merge: 'oldest_entity_id',
          split: 'preserve_anchor',
        },
      } satisfies ResolvedResolutionSpec,
    ]);

    expect(fields).toEqual(['email', 'standardized_email']);
    expect(resolvePiiRedactFields({ name: 'default' }, fields)).toEqual(fields);
    expect(
      resolvePiiRedactFields(
        { name: 'explicit', review_export: { redact_fields_for_agent_review: ['ssn'] } },
        fields
      )
    ).toEqual(['ssn']);
  });
});
