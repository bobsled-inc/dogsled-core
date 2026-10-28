---
module: dogsled-action-system
date: 2026-04-23
problem_type: integration_issue
component: webhook action transport
symptoms:
  - 'Webhook action schema rejected `Authorization` headers during validation.'
  - 'Webhook dry runs and executions failed when optional request-body fields were omitted from the input payload.'
root_cause: Shared extractor request safety rules were too strict for outbound webhooks, and generic interpolation treated missing whole-value body placeholders as fatal instead of sparse optional fields.
severity: medium
tags: [actions, webhook, validation, interpolation]
---

# Webhook Action Authorization And Sparse Payloads

## Symptom

The first webhook-action pass hit two issues during implementation:

- `ActionSpecSchema.safeParse()` rejected webhook specs that included an `Authorization` header.
- Webhook dry runs and executions failed when request bodies contained optional placeholders such as `${{ input.completed_at }}` and the caller did not provide that field.

## Investigation

The initial schema reused the extractor's shared safe-header validation, which is designed for generated API requests and is stricter than what outbound webhook calls need.

The webhook transport also reused generic interpolation behavior. That behavior is correct for required request pieces, but it makes sparse JSON bodies awkward because a missing whole-value placeholder throws instead of simply omitting the field.

## Root Cause

Two different concerns were accidentally collapsed into one implementation:

1. Header safety for extractor-managed HTTP requests.
2. Header safety for user-authored outbound webhooks.

The shared schema blocked `Authorization`, which is unsafe to let integrations override in extractor requests but valid for webhook actions.

Separately, webhook bodies need to support partial payloads. A body field whose entire value is a missing `${{ input.* }}` or `${{ mapped.* }}` token should usually disappear instead of aborting the request.

## Solution

The fix split the behavior by transport:

1. Added a webhook-specific header schema that still blocks dangerous hop-by-hop overrides like `Host`, `Content-Length`, `Transfer-Encoding`, and `Connection`, but allows `Authorization`.
2. Added recursive webhook body interpolation that omits fields whose full value is a missing `input` or `mapped` placeholder.
3. Kept ordinary interpolation errors intact for non-optional shapes, so malformed templates still fail loudly.

Relevant code:

- [packages/extractor/src/framework/extractor/action.ts](../../../packages/extractor/src/framework/extractor/action.ts)
- [packages/dogsled/src/lib/transports/webhook.ts](../../../packages/dogsled/src/lib/transports/webhook.ts)

## Prevention

- Keep transport-specific safety rules separate when the threat model differs.
- Add unit coverage for webhook specs that include auth headers.
- Add unit coverage for sparse request bodies where optional fields are intentionally absent.
- Treat whole-value interpolation tokens differently from mixed literal/template strings when optional omission is expected.

## Related Issues

- [query-resource-wrapper-metadata-split-20260422.md](./query-resource-wrapper-metadata-split-20260422.md)
