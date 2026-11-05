# Privacy

<!-- last-reviewed: 2026-07-27 -->

Dogsled is a local-first data engineering toolkit. It has no required hosted
account, hosted control plane, or default maintainer telemetry. Configuration,
state, and semantic context live in the operator's project and infrastructure.

## Where data can flow

Dogsled processes data only through capabilities the operator invokes and
configures:

- extractors read local documents, APIs, databases, warehouses, object stores,
  and MCP tools;
- optional embedding and AI features send selected content to the provider
  configured in `dogsled.yml`;
- loaders write records to the configured local, database, warehouse, search,
  vector, or object-storage destination;
- operators can run `dogsled runner run` from their own workflow steps, using
  the secrets, variables, permissions, and environments they configure.

These providers and destinations have their own privacy and retention terms.
Dogsled does not proxy their traffic through a maintainer-operated service.

## Credentials

Checked-in configuration should reference credentials through environment
variables or GitHub secrets. Dogsled does not intentionally write raw credentials
into project configuration, state, or reports. Error and
diagnostic paths apply credential redaction, but operators should still treat
logs and generated artifacts as sensitive and review them before sharing.

Never commit `.env` files, cloud credentials, npm authentication, or exported
customer data.

## Local state and retention

Depending on the commands and destinations used, an operator's environment may
contain:

- extracted records and Dogsled protocol JSONL streams;
- DuckDB, DuckLake, SQLite, warehouse, or destination tables;
- cursor and runner state;
- caches, batches, generated SQL, compiled models, and temporary files;
- logs, error bodies, manifests, workflow artifacts;
- entity-resolution review queues, decisions, embeddings, and generated SDKs.

Dogsled bounds and cleans up security-sensitive temporary files where the runtime
owns their lifecycle. Destination data, project state, CI artifacts, logs, and
support exports remain under the operator's retention and deletion policies.
Delete them using the controls of the filesystem, repository, CI platform, and
configured providers that store them.

## Agentic model data

Agentic executors can send prepared records, instructions, intermediate findings,
and retrieved context to the selected AI provider. The built-in TypeSafe executor
sends classification inputs to TypeSafe. Extra host tools and custom executors
have their own network behavior; review them before loading them. A local executor
module is trusted application code and is not sandboxed by Dogsled.

Agentic checkpoints retain frozen inputs, model definitions, accepted and
intermediate results, evidence, and usage under `.dogsled/model-spec/` or the configured
checkpoint store. Warehouse payload encoding is not encryption. Published findings,
publication stages, receipts, and shared input cursors can remain in the output
database. These records can contain source data and personal information.

Runs saved in DuckDB expire: Dogsled removes a run 30 days after its last write, or after
`retention_days` for a DuckDB `checkpoint_store`, unless it is still owed publication or cursor
recovery. This is storage housekeeping, not secure erasure. Nothing else expires automatically,
including runs in the file store, warehouse checkpoints and publication stages.
Apply storage access controls and a retention policy that preserves pending work
and receipts needed for recovery. Removing required state prevents resume. See
[agentic operations](docs/reference/advanced/agentic-model-operations.md#retention-and-cleanup)
for cleanup rules and links to the storage contracts.

## Sensitive and personal data

Integration schemas may include names, email addresses, identifiers, document
content, or other personal data. Operators are responsible for determining
whether a source may be processed, limiting extracted fields and records,
selecting appropriate destinations and AI providers, and satisfying applicable
access, retention, deletion, and data-residency obligations.

Dogsled's entity-graph privacy helpers can normalize or hash selected match keys,
but pseudonymized or hashed identifiers may still be personal data.

## Diagnostics and security reviews

The repository's security-review harness stores raw scanner evidence under the
gitignored `.security-review/` directory. Raw reports can contain private paths,
code excerpts, or secret-like values and must not be uploaded as CI artifacts
or committed. Review and redact diagnostics before sharing them.

Dogsled does not silently enable analytics, remote error reporting, or
maintainer-operated runtime endpoints. The security policy check protects that default.

## When this review must be updated

Re-review this document and the implementation before adding:

- telemetry, analytics, remote logging, crash reporting, or support uploads;
- a hosted control plane required by the OSS runtime;
- new persistent state or materially different temporary-file behavior;
- a new AI, embedding, MCP, or external network provider;
- new generated-workflow permissions, artifact retention, or secret handling;
- behavior that changes how operators delete or export stored data.

Security vulnerabilities should be reported through the process in
[`SECURITY.md`](SECURITY.md), without including production credentials or real
customer data.
