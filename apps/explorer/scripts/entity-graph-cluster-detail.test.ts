import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClusterDetailPayload } from '../src/lib/entity-graph-cluster-detail';

test('parseClusterDetailPayload accepts a valid API payload', () => {
  const payload = parseClusterDetailPayload({
    cluster_id: 'cluster_123',
    scenario: 'default',
    entity: 'company',
    profile: {
      cluster_id: 'cluster_123',
      display_name: 'Acme',
      source_count: 2,
      record_count: 3,
      trust_tier: 'gold',
      entity_trust_score: 0.98,
      identity_confidence: 0.97,
      freshness_score: 0.88,
    },
    members: [
      {
        record_id: 'rec_1',
        source_ref: 'hubspot',
        source_system: 'hubspot',
        source_entity_id: '123',
        confidence_score: 0.93,
        matched_at: '2026-04-19T12:00:00.000Z',
        member_fields: [
          { key: 'name', label: 'Name', value: 'Acme Corp' },
          { key: 'website', label: 'Website', value: 'acme.com' },
        ],
      },
    ],
    golden_record: [
      {
        attribute_name: 'name',
        attribute_label: 'Name',
        attribute_value: 'Acme',
        source_system: 'hubspot',
        updated_at: '2026-04-19T12:00:00.000Z',
      },
    ],
    survivorship_audit: [
      {
        attribute_name: 'name',
        chosen_value: 'Acme',
        source_system: 'hubspot',
        strategy: 'most_recent',
        decided_at: '2026-04-19T12:00:00.000Z',
      },
    ],
    business_snapshot: [{ label: 'Revenue', value: '$1,200', context: 'Example context' }],
  });

  assert.equal(payload.profile.display_name, 'Acme');
  assert.equal(payload.members[0]?.source_system, 'hubspot');
  assert.equal(payload.members[0]?.member_fields[0]?.value, 'Acme Corp');
  assert.equal(payload.golden_record[0]?.attribute_name, 'name');
  assert.equal(payload.business_snapshot[0]?.label, 'Revenue');
});

test('parseClusterDetailPayload rejects malformed payloads before render', () => {
  assert.throws(
    () =>
      parseClusterDetailPayload({
        cluster_id: 'cluster_123',
        entity: 'company',
        profile: {
          cluster_id: 'cluster_123',
          display_name: 'Acme',
          source_count: 2,
          record_count: 3,
          trust_tier: 'gold',
          entity_trust_score: 0.98,
          identity_confidence: 0.97,
          freshness_score: 0.88,
        },
        members: 'bad-data',
        golden_record: [],
        survivorship_audit: [],
        business_snapshot: [],
      }),
    /Invalid cluster detail response: members/
  );
});

test('parseClusterDetailPayload accepts business snapshot cards without context', () => {
  const payload = parseClusterDetailPayload({
    cluster_id: 'cluster_123',
    entity: 'company',
    profile: {
      cluster_id: 'cluster_123',
      display_name: 'Acme',
      source_count: 2,
      record_count: 3,
      trust_tier: 'gold',
      entity_trust_score: 0.98,
      identity_confidence: 0.97,
      freshness_score: 0.88,
    },
    members: [],
    golden_record: [],
    survivorship_audit: [],
    business_snapshot: [{ label: 'Revenue', value: '$1,200' }],
  });

  assert.equal(payload.business_snapshot[0]?.label, 'Revenue');
  assert.equal(payload.business_snapshot[0]?.context, undefined);
});
