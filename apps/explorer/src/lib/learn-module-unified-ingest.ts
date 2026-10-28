import type { LearnModule } from './learn-curriculum';
import { command, terminalAction } from './learn-module-helpers';

export const UNIFIED_INGEST_MODULE: LearnModule = {
  id: 'unified-ingest',
  title: 'Unified Ingest — Structured Rows and Unstructured Documents',
  group: 'advanced-elt',
  description:
    'Connect one local document source and one public API source through the same protocol, DuckDB load, and local query surface.',
  outcome:
    'You can explain the first-ingest demo, inspect document streams, and know which pieces are CLI-first today.',
  estimatedMinutes: 22,
  cliPhaseIds: ['unified-ingest'],
  steps: [
    {
      id: 'unified-grammar',
      kind: 'concept',
      title: 'One grammar for documents and APIs',
      body: 'The first-ingest example has two resources: local_docs/first_pdf parses a committed PDF, while github_public/public_repos reads unauthenticated GitHub REST rows. Both resources emit the same SCHEMA, RECORD, and STATE protocol before loading. The loader only sees typed streams, not whether rows came from a file parser or an HTTP endpoint.',
      cliLessonId: 'first-ingest-unified-grammar',
      command: command('examples', ['list']),
      action: terminalAction('Open Examples', command('examples', ['list'])),
    },
    {
      id: 'validate-specs',
      kind: 'spec',
      title: 'Validate before runtime',
      body: 'The CLI walkthrough starts in examples/first-ingest and runs extract validate against the local integration and resource files. Explorer Terminal currently starts from the repo workspace and does not encode a lesson cwd in terminal links, so use the shell walkthrough for this specific validation command and use Terminal for safe command inspection.',
      cliLessonId: 'first-ingest-validate',
      command: command('extract', ['--help']),
      action: terminalAction('Open Extract Help', command('extract', ['--help'])),
    },
    {
      id: 'document-streams',
      kind: 'concept',
      title: 'Document streams are relational',
      body: 'The PDF resource emits first_pdf__documents for file metadata and extracted text, first_pdf__chunks for token-bounded text chunks, first_pdf__parse_errors for parser failures, and first_pdf__acl for permission evidence. These names are stable enough for agents to query directly after the DuckDB load.',
      cliLessonId: 'first-ingest-document-streams',
    },
    {
      id: 'chunk-ids',
      kind: 'table',
      title: 'Chunks have stable IDs',
      body: 'Each chunk row carries chunk_id, document_version_id, document_id, chunk_index, token_count, text, and chunker_config_hash. The chunk_id is derived from the document version, chunker config, chunk index, and text, which makes later retrieval and citation deterministic.',
      cliLessonId: 'first-ingest-chunk-ids',
      sql: 'SELECT chunk_id, chunk_index, token_count FROM first_pdf__chunks ORDER BY chunk_index LIMIT 5',
    },
    {
      id: 'acl-evidence',
      kind: 'table',
      title: 'ACL evidence is captured separately',
      body: 'Permission evidence lands in first_pdf__acl with row_id, row_type, principal_id, source_grant_type, source_provider, source_revision, and captured_at. The default local file path needs no credentials and may have no provider ACL rows, but the contract remains visible for downstream policy-aware consumers.',
      cliLessonId: 'first-ingest-acl-evidence',
      sql: 'SELECT row_id, row_type, principal_id, source_grant_type, source_provider FROM first_pdf__acl LIMIT 5',
    },
    {
      id: 'side-by-side-load',
      kind: 'concept',
      title: 'API and document rows load side by side',
      body: 'The walkthrough loads first_pdf streams and public_repos into the same first-ingest.duckdb file. That is the core unified-ingest shape: local documents and public APIs can land together without connection credentials, embedding credentials, or a protocol fork.',
      cliLessonId: 'first-ingest-side-by-side',
      command: command('load', ['--help']),
      action: terminalAction('Open Load Help', command('load', ['--help'])),
    },
    {
      id: 'local-querying',
      kind: 'query',
      title: 'Query the local outputs',
      body: 'After running cd examples/first-ingest && ./walkthrough.sh in a shell, query first_pdf__documents, first_pdf__chunks, first_pdf__parse_errors, first_pdf__acl, and public_repos from first-ingest.duckdb. Explorer Terminal does not yet run the full piped walkthrough from this cwd, so the runnable path stays script and CLI first.',
      cliLessonId: 'first-ingest-local-querying',
      sql: 'SELECT name, full_name, stargazers_count FROM public_repos ORDER BY updated_at DESC LIMIT 5',
      command: command('load', ['query', '--help']),
      action: terminalAction('Open Query Help', command('load', ['query', '--help'])),
    },
  ],
};
