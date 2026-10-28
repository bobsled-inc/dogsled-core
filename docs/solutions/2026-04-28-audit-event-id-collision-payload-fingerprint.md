---
title: Audit Event ID Collisions From Synthetic Timestamp Concatenation
date: 2026-04-28
tags: [entity-graph, audit, codegen, sql]
category: codegen
module: entity-graph
symptoms:
  - duplicate-event-ids-in-audit-log
  - rapid-cli-invocations-overwrite-audit-events
  - audit-verify-fails-distinct-event-id-check-after-bulk-mutation
---

# Audit Event ID Collisions From Synthetic Timestamp Concatenation

## Problem

Drop 1 of the entity graph foundation introduced an `entity_graph.audit_log` table whose primary key is a synthetic `event_id` constructed as `'eg-' || CURRENT_TIMESTAMP || '-' || payload.kind || '-' || subject_id`. For one-shot mutation events (e.g. `audit_unmerge` and `audit_split` emitted by `dogsled entity-graph review unmerge`), `subject_id` is the cluster id and `kind` is fixed. Two rapid invocations against the same cluster within one `CURRENT_TIMESTAMP` resolution tick (Snowflake/BigQuery resolve `CURRENT_TIMESTAMP` at statement start; multiple inserts inside one batch share it) collapse to the same `event_id`. The `audit verify` query relies on `COUNT(*) = COUNT(DISTINCT event_id)` to detect log corruption; it silently passes for the duplicate insert because the row physically exists once, just with a confusing audit trail.

The same collision shape applies to any future audit producer whose static-payload event differs only by timestamp.

## Solution

Append a deterministic payload fingerprint to the `event_id` whenever the producer can compute one, and require the SQL CTEs that re-emit the audit row (e.g. survivorship `WHERE NOT EXISTS`) to match on the fingerprint as well.

```ts
// audit/codegen.ts
function payloadFingerprint(payload: AuditPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

const discriminator = input.eventIdDiscriminator ?? payloadFingerprint(input.payload);
const eventId = eventIdExpr(
  [
    quoteLiteral(input.payload.kind, dialect),
    quoteLiteral('-', dialect),
    quoteLiteral(input.subjectId, dialect),
    quoteLiteral('-', dialect),
    quoteLiteral(discriminator, dialect),
  ],
  dialect
);
```

For unmerge/split events, the caller passes the cluster `content_hash` as `eventIdDiscriminator` so two unmerge runs with different `--keep` lists or `--reason` strings produce different event ids even at the same timestamp. For survivorship and review-apply events, the existing `decided_at` / `decision_batch_id + content_hash` already make event ids unique, so the default payload fingerprint is the only addition.

Verify queries should also be tolerant of whitespace `event_id` values:

```sql
-- audit/codegen.ts buildAuditVerifyQuery
${event_id} IS NULL OR TRIM(CAST(${event_id} AS TEXT)) = ''
```

## Why this matters

- Audit logs are append-only mutation evidence. A silently overwritten event is worse than a missing one, because operators relying on `audit verify` think the log is intact.
- Synthetic IDs derived from "timestamp + a small set of discriminators" are the simplest path for OSS audit tables where UUIDv7 generation isn't portable across dialects, but they require explicit fingerprint discriminators per call site.
- Whitespace tolerance in verify queries protects against runners that emit `'   '` instead of `NULL` for empty event ids.

## How to apply

When adding a new audit producer:

1. Identify what disambiguates two same-payload, same-subject events (decision batch id, content hash, run id). Pass it as `eventIdDiscriminator` to `generateAuditInsertSql`.
2. If no natural discriminator exists, the payload fingerprint default already covers same-payload duplicate suppression — make sure the payload itself contains enough state.
3. When emitting INSERT … SELECT audit rows from a derived CTE (survivorship pattern), include the discriminator in the `WHERE NOT EXISTS` event-id match so reruns truly no-op.
4. Add a regression test that calls the codegen twice with different content hashes and asserts the SQL contains both hashes literally.

Test reference: `packages/entity-graph/tests/unit/compiler/resolution/foundation.test.ts` — `embeds the content hash in unmerge audit event ids to prevent collisions`.
