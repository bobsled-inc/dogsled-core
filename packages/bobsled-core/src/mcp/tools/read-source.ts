/**
 * `read_source` MCP tool.
 *
 * Returns rows from `<resource>__documents` / `<resource>__chunks` with
 * citation metadata. Recognizes document/chunk tables vs structured tables
 * via suffix sniffing.
 *
 * Search and traverse tools are not included; this is the minimum surface
 * that makes documents queryable through MCP.
 */

import { assertSafeIdentifier } from '@bobsled-inc/entity-graph/runtime/candidate-retrieval';
import { CommandError } from '@bobsled-inc/protocol';

import type {
  Citation,
  McpToolResponse,
  PrincipalContext,
  RoutingMetadata,
  BobsledMcpServer,
} from '../server.js';

export interface ReadSourceInput {
  source_table: string;
  limit?: number;
  /** Optional cursor — opaque string returned by previous response. */
  cursor?: string;
}

/**
 * One row from the underlying table. Field set is table-shape-dependent —
 * the MCP boundary stays string-keyed but the type alias makes the boundary
 * explicit so callers don't proliferate `Record<string, unknown>` ad-hoc.
 */
export type SourceRowData = Record<string, unknown>;

export interface ReadSourceRow {
  /** Free-form row payload — matches the underlying table shape. */
  data: SourceRowData;
  /** Per-row citation extracted from document/chunk metadata when applicable. */
  citation?: Citation;
}

export interface ReadSourceOutput {
  rows: ReadSourceRow[];
  next_cursor?: string;
}

export interface RowFetchResult {
  rows: SourceRowData[];
  next_cursor?: string;
}

export interface RowFetchRequest {
  input: ReadSourceInput;
  /**
   * Principal forwarded from the MCP request. Backends MUST apply ACL
   * filtering against this — the type contract makes that non-skippable
   *. `null` is reserved for runs explicitly
   * authorized via `--allow-unfiltered` AND `BOBSLED_CORE_MCP_ALLOW_UNFILTERED=1`
   * (per `requirePrincipal()`); fetchers receiving `null` MUST emit a WARN
   * log on first call.
   */
  principal: PrincipalContext | null;
}

export type RowFetcher = (request: RowFetchRequest) => Promise<RowFetchResult>;

export interface ReadSourceContext {
  server: BobsledMcpServer;
  principal: PrincipalContext | null;
  fetcher: RowFetcher;
}

const DOCUMENT_SUFFIX = '__documents';
const CHUNK_SUFFIX = '__chunks';
export const READ_SOURCE_MAX_LIMIT = 1_000;
export const READ_SOURCE_MAX_CURSOR_BYTES = 4_096;
// Control characters (except tab/LF/CR) corrupt downstream log strings and
// have no legitimate use in an opaque cursor.
const CURSOR_CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function isDocumentOrChunkTable(table: string): { kind: 'document' | 'chunk' | 'structured' } {
  if (table.endsWith(DOCUMENT_SUFFIX)) return { kind: 'document' };
  if (table.endsWith(CHUNK_SUFFIX)) return { kind: 'chunk' };
  return { kind: 'structured' };
}

function buildCitation(
  kind: 'document' | 'chunk' | 'structured',
  row: Record<string, unknown>
): Citation | undefined {
  if (kind === 'structured') return undefined;
  const documentId = typeof row['document_id'] === 'string' ? row['document_id'] : '';
  const documentVersionId =
    typeof row['document_version_id'] === 'string' ? row['document_version_id'] : '';
  const sourceUri = typeof row['source_uri'] === 'string' ? row['source_uri'] : '';
  // Required identifiers — drop the citation entirely if any is missing
  //. An invalid Citation is worse than no
  // citation because downstream consumers may persist or display the
  // empty-string form.
  if (!documentId || !documentVersionId || !sourceUri) return undefined;
  const citation: Citation = {
    document_id: documentId,
    document_version_id: documentVersionId,
    source_uri: sourceUri,
    acl_principals: [],
    source_grant_types: [],
  };
  if (kind === 'chunk') {
    if (typeof row['chunk_id'] === 'string') citation.chunk_id = row['chunk_id'];
    if (typeof row['chunk_index'] === 'number') citation.chunk_index = row['chunk_index'];
  }
  if (typeof row['title'] === 'string') citation.title = row['title'];
  return citation;
}

export async function readSource(
  context: ReadSourceContext,
  input: ReadSourceInput
): Promise<McpToolResponse<ReadSourceOutput>> {
  // Validate principal before any fetcher call so unauthenticated requests
  // never reach the data plane. The result is forwarded into the fetcher's
  // typed request — making ACL enforcement a non-skippable signature.
  const principal = context.server.requirePrincipal(context.principal);
  // Validate `source_table` at the MCP boundary so a fetcher implementation
  // that string-interpolates the value (or that forgets to validate) cannot
  // be used as a SQL injection sink. The same identifier validator the
  // candidate-retrieval runners use on `--schema`/`--table` covers the
  // shape the entity-graph tables are guaranteed to have. (Security review
  // on defense-in-depth at the agent boundary.)
  assertSafeIdentifier(input.source_table, 'source_table');
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > READ_SOURCE_MAX_LIMIT)
  ) {
    throw new CommandError(
      `read_source.limit must be an integer between 1 and ${READ_SOURCE_MAX_LIMIT}.`,
      2
    );
  }
  // The MCP request is JSON, so cursor lands as whatever the client sent —
  // type contract is `string | undefined`, but a malformed client can pass
  // numbers, objects, or oversized blobs. Validate at the boundary so a
  // fetcher that string-interpolates or forwards the value cannot be abused.
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string') {
      throw new CommandError('read_source.cursor must be a string.', 2);
    }
    if (Buffer.byteLength(input.cursor, 'utf8') > READ_SOURCE_MAX_CURSOR_BYTES) {
      throw new CommandError(
        `read_source.cursor exceeds ${READ_SOURCE_MAX_CURSOR_BYTES} bytes.`,
        2
      );
    }
    if (CURSOR_CONTROL_CHAR_REGEX.test(input.cursor)) {
      throw new CommandError('read_source.cursor contains control characters.', 2);
    }
  }
  context.server.requireSourcePermission(input.source_table, principal);
  const fetchInput = { ...input };
  const { kind } = isDocumentOrChunkTable(input.source_table);
  const fetched = await context.fetcher({ input: fetchInput, principal });
  const permissionResult = await context.server.applyPermissionAdapters(
    input.source_table,
    fetched.rows,
    principal
  );

  const rows: ReadSourceRow[] = permissionResult.rows.map((data) => {
    const citation = buildCitation(kind, data);
    return citation ? { data, citation } : { data };
  });

  const routing: RoutingMetadata = {
    resolved_via: 'direct',
    cache_hit: false,
    embedding_available: false,
  };

  return {
    result: { rows, next_cursor: fetched.next_cursor },
    permissions: permissionResult.permissions,
    citations: rows.map((r) => r.citation).filter((c): c is Citation => Boolean(c)),
    routing_metadata: routing,
  };
}
