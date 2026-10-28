import type { Lesson } from './lessons.js';

export const INGEST_LESSONS: Lesson[] = [
  // ── Unified Ingest ────────────────────────────────────────────────
  {
    id: 'first-ingest-unified-grammar',
    title: 'Unified Ingest Grammar',
    type: 'note',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    body: [
      'The first-ingest example uses two source types:',
      '  • local_docs/first_pdf reads a local PDF from sources/docs',
      '  • github_public/public_repos reads unauthenticated public GitHub REST rows',
      '',
      'Both sources emit the same SCHEMA, RECORD, and STATE protocol before loading.',
    ],
    why: 'Shows that document and API sources share one extractor contract',
    think: 'Different sources should converge on the same wire shape',
  },
  {
    id: 'first-ingest-validate',
    title: 'Validate Ingest Specs',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    command: 'dogsled extract validate',
    why: 'Checks the local document and public API specs before any extraction',
    think: 'Validation is the fastest way to catch config drift before runtime',
  },
  {
    id: 'first-ingest-document-streams',
    title: 'Document Streams',
    type: 'note',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    body: [
      'first_pdf emits four ontology-facing streams:',
      '  • first_pdf__documents — one row per parsed file',
      '  • first_pdf__chunks — queryable text chunks',
      '  • first_pdf__parse_errors — structured parser failures',
      '  • first_pdf__acl — permission evidence schema and rows when available',
    ],
    why: 'Documents become predictable relational tables',
    think: 'Stable stream names let downstream agents query documents without custom parsing',
  },
  {
    id: 'first-ingest-run-walkthrough',
    title: 'Run the Local Walkthrough',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    command: './walkthrough.sh',
    why: 'Runs the credential-free PDF plus public API demo end to end',
    think: 'A durable local demo should prove extract, load, and query in one pass',
  },
  {
    id: 'first-ingest-chunk-ids',
    title: 'Inspect Chunk IDs',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    command:
      'dogsled query --db-path ./first-ingest.duckdb "SELECT chunk_id, chunk_index, token_count FROM first_pdf__chunks ORDER BY chunk_index LIMIT 5"',
    why: 'Shows stable chunk identity and token counts after parsing',
    think: 'Chunk IDs make document text addressable for later retrieval and citation',
  },
  {
    id: 'first-ingest-acl-evidence',
    title: 'Inspect ACL Evidence',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    command:
      'dogsled query --db-path ./first-ingest.duckdb "SELECT row_id, row_type, principal_id, source_grant_type, source_provider FROM first_pdf__acl LIMIT 5"',
    why: 'Shows the permission evidence table contract',
    think: 'Even when local files have no provider ACL backend, the table shape is explicit',
  },
  {
    id: 'first-ingest-side-by-side',
    title: 'Query Documents and API Rows',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    command:
      'dogsled query --db-path ./first-ingest.duckdb "SELECT (SELECT count(*) FROM first_pdf__chunks) AS chunk_count, (SELECT count(*) FROM public_repos) AS repo_count"',
    why: 'Confirms document chunks and GitHub rows landed in the same DuckDB file',
    think: 'Side-by-side loading is the bridge from raw ingestion to ontology-facing outputs',
  },
  {
    id: 'first-ingest-local-querying',
    title: 'Query Local Outputs',
    section: 'Unified Ingest',
    cwd: 'first-ingest',
    command:
      'dogsled query --db-path ./first-ingest.duckdb "SELECT name, full_name, stargazers_count FROM public_repos ORDER BY updated_at DESC LIMIT 5"',
    why: 'Finishes with direct local SQL over API rows',
    think: 'Queryable local outputs are the default success condition for connection-free ingest',
  },
];
