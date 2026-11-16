# Entity Graph External Reviewer Contract

Bobsled Core's agent review phase (`entity-graph resolve review`) can ship the
unreviewed gray-zone pairs to an **external reviewer** — any agent you host or
run locally — instead of the built-in model judge. This page is the wire
contract for bringing your own reviewer: the request Bobsled Core sends, the response
it expects, and what happens when things go wrong.

The reviewer is configured in the resolution spec:

```yaml
# entity-graph/<entity>_resolution.yml
agent_policy:
  enabled: true
  judge: agent # optional tier selector; absent → model (see below)
  reviewer: # optional; absent → built-in model judge (agent_policy.model)
    kind: http # http | command
    url: https://reviewer.example/review # kind: http
    auth_token: ${{ env.REVIEWER_TOKEN }} # env placeholder — never a literal
    timeout_s: 300 # default 300; per batch of pairs
    poll_interval_s: 5 # http only; default 5
    # command: 'my-reviewer --json'           # kind: command (mutually exclusive with url)
```

## Judge tier — `agent_policy.judge`

`agent_policy.judge` picks the lane that serves the review phase. It is a
per-entity selector: pinning one entity's tier never affects another entity in
the same run.

| `judge`                      | Who serves the phase                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent (**default → model**) | Today's precedence, unchanged: an external transport (`reviewerOverride` > `agent_policy.reviewer`) still wins when present; otherwise the built-in model judge / panel serves. Backward-compatible for every existing spec.                                                  |
| `model`                      | **Pin the built-in model judge.** `reviewerOverride` **and** `agent_policy.reviewer` are ignored (a host cannot upgrade a pinned-model entity; an ignored override is surfaced as a warning).                                                                                 |
| `agent`                      | **Require an external/tool-using reviewer transport** (`reviewerOverride` > `agent_policy.reviewer`). If neither is available the phase **skips** with `skipped_reason: 'no_judge_configured'` and a warning naming the missing piece — it never falls back to the model judge. |

A host-injected `llmClient` (the programmatic/test escape hatch) still wins over
every tier, including a pinned `judge`. Skips are fail-soft: a missing agent-tier
reviewer leaves the queue intact and never fails the run.

Judge precedence in `resolve review` (once the tier lane is chosen): a
host-injected `llmClient` > `reviewerOverride` (programmatic) >
`agent_policy.reviewer` > `agent_policy.model` (single judge and/or panel).
External reviewer decisions are written with `decision_source: 'agent'`; the
built-in model judge writes `'agent_auto'`.

## Request — `entity_graph_review_request.v1`

Both transports receive the same JSON document. Over `http` it is the POST
body; over `command` it arrives on stdin. Bobsled Core sends one request per batch of
pairs (`agent_policy.batch_size`, default 100).

```jsonc
{
  "version": "entity_graph_review_request.v1",
  "job": {
    "entity": "company", // entity being resolved
    "max_pairs": 200, // number of pairs in THIS request
    "timeout_s": 300, // your deadline: Bobsled Core stops waiting after this
    "max_cost_usd": 50.0, // optional (additive); present only when agent_policy.max_cost_usd is set
  },
  "context": {
    // Optional; present when the resolution spec declares entity_semantics.
    "entity_semantics": {
      "definition": "A company is a distinct legal business entity...",
      "categories": [{ "name": "brand", "description": "Consumer brand." }],
      "positive_examples": ["Acme Corp ↔ Acme Corporation (same domain)"],
      "negative_examples": ["Acme US ↔ Acme Japan (regional subsidiaries)"],
    },
    // Optional; precedent text summarizing prior confirmed/rejected decisions.
    "learning_context": "...",
    "target_schema": "entity_graph",
    "dialect": "duckdb",
  },
  // PairContext[], camelCase — exactly Bobsled Core's type.
  "pairs": [
    {
      "pairId": "a1|b1",
      "recordAId": "a1",
      "recordBId": "b1",
      "sourceA": "crm",
      "sourceB": "billing",
      "compositeScore": 0.73,
      "fields": {
        "name": { "a": "Acme Corp", "b": "acme corp", "score": 0.93 },
        "domain": { "a": "acme.com", "b": "acme.com", "score": 1 },
      },
    },
  ],
}
```

## Response — decisions

A decision has this shape (camelCase, exactly Bobsled Core's `PairDecision` type):

```jsonc
{
  "pairId": "a1|b1", // must match a pairId from the request
  "decision": "merge", // "merge" | "not_match" | "defer"
  "confidence": 0.92, // [0, 1]; out-of-range values are clamped
  "reasoning": "Same domain and near-identical name.",
}
```

`defer` means "a human should look at this" — the pair lands in the human
review queue as `deferred`. Omitting a pair entirely means "I didn't get to
it" — the pair simply stays in the agent queue for the next run. Prefer
omission over low-confidence guessing.

### Usage reporting (optional, additive)

Any decisions response — the sync `200 { decisions }` body, the async poll
`{ status: "done", decisions }` body, and the `command`-transport stdout — may
carry an optional `usage` block. Both fields are optional; an absent block is a
no-op:

```jsonc
{
  "decisions": [ ... ],
  "usage": {
    "tokens_used": 12000, // optional; accumulated across batches
    "cost_usd": 0.42, // optional; accumulated across batches
  }
}
```

Bobsled Core accumulates `usage` across every batch of a run. When `job.max_cost_usd`
is set and the accumulated `cost_usd` reaches it, Bobsled Core stops dispatching
further batches (the remaining pairs stay in the queue for the next run) —
matching the built-in model judge's cost-ceiling behavior. Unrecognized keys are
ignored; malformed `usage` is treated as absent.

### `http` transport

```text
POST {url}
Authorization: Bearer {auth_token}     (when auth_token is configured)
Content-Type: application/json
```

Respond either **synchronously** (small batches):

```text
200 OK
{ "decisions": [ PairDecision, ... ] }
```

or **asynchronously** — acknowledge, then let Bobsled Core poll:

```text
202 Accepted
{ "job_id": "abc123" }
```

Bobsled Core then polls `GET {url}/{job_id}` (same bearer token) every
`poll_interval_s` seconds until `timeout_s` is exhausted:

```jsonc
{ "status": "running" }
{ "status": "done", "decisions": [ ... ] }
{ "status": "failed", "error": "why" }
```

The reviewer URL must be `https` (a bearer token travels with every request);
plain `http` is allowed only for loopback hosts. HTTP redirects are refused —
respond directly from the configured URL, or the request counts as a
transport failure.

### `command` transport

Bobsled Core executes a local argv array such as `command: [node, reviewer.mjs]` without a shell, with only PATH, system-root, temporary-directory and locale variables. Quoted command strings remain supported without expansion. The process receives request JSON on stdin and must print one JSON document to stdout:

```json
{ "decisions": [] }
```

and exit 0. Non-zero exits, output that isn't valid JSON, and processes still
running at `timeout_s` (they are killed) all count as transport failures.

A minimal reviewer:

```js
// my-reviewer.mjs — reads the request on stdin, merges everything it is sure about
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
process.stdout.write(
  JSON.stringify({
    decisions: request.pairs.map((pair) => ({
      pairId: pair.pairId,
      decision: pair.compositeScore > 0.9 ? 'merge' : 'defer',
      confidence: pair.compositeScore,
      reasoning: `composite score ${pair.compositeScore}`,
    })),
  })
);
```

```yaml
agent_policy:
  enabled: true
  reviewer:
    kind: command
    command: 'node my-reviewer.mjs'
    timeout_s: 120
```

## Failure semantics (fail-soft)

A reviewer problem **never fails the run**. On timeout, transport error,
non-JSON output, or a `failed` job status, the affected pairs get **no
decision** — they stay in the review queue for the next attempt — and the run
finishes green (exit 0) with warnings describing what happened.

Within an otherwise valid response:

- decisions for **unknown `pairId`s** are dropped with a warning;
- **duplicate** decisions for the same pair keep the first, with a warning;
- **malformed** decision entries are dropped with a warning;
- `confidence` outside `[0, 1]` is clamped.

Valid decisions then flow through the same confidence gate as every other
review path: confidence ≥ `agent_policy.auto_apply_threshold` (default 0.75)
is `applied`, below it is `proposed` (human confirmation), `defer` is
`deferred`. Applied merges fold into golden records on the next
`resolve cluster`.

## Secrets

`auth_token` must be an env placeholder (`$MY_TOKEN` or
`${{ env.MY_TOKEN }}`), resolved at runtime through the project's secret
resolver (`--secrets <file>` or process env). Literal tokens are rejected at
spec validation time.

## Programmatic use

Hosts embedding Bobsled Core can skip YAML entirely:

```ts
import { reviewResolveProject } from '@bobsled-inc/entity-graph/api';

await reviewResolveProject({
  cwd,
  integration: 'warehouse',
  reviewerOverride: { kind: 'http', url: '...', authToken: '${{ env.TOKEN }}' },
  // or llmClient: { reviewPairs: async (pairs, options) => [...] } to bypass transports
});
```

`reviewerOverride` wins over the spec's `agent_policy.reviewer`; an injected
`llmClient` wins over both.

## Related

- Authoring guide: [`docs/reference/advanced/entity-graph-authoring-guide.md`](entity-graph-authoring-guide.md)
  (agent review configuration, model judge, panels)
- Demo project: `workspace/entity-graph-demo`
