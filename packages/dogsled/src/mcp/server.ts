/**
 * Dogsled-as-MCP-server.
 *
 * This is the OUTBOUND MCP surface — Dogsled exposing data to MCP clients
 * (agents). Distinct from `packages/extractor/src/runtime/mcp-*.ts` which is
 * Dogsled-as-MCP-CLIENT (consuming Notion/Atlassian/etc.).
 *
 * v1 ships a single `read_source` tool that returns rows from
 * `<resource>__documents` / `<resource>__chunks` with citation metadata.
 *
 * **Fail-closed default**: requires `principal` in every request context
 * unless `--allow-unfiltered` flag set AND `DOGSLED_MCP_ALLOW_UNFILTERED=1`
 * env var present. Both required (mirrors the
 * `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1` precedent).
 */

import { CommandError } from '@bobsled-inc/protocol';

import type { PermissionAdapter, PermissionMetadata, Principal } from './permissions.js';

export type PrincipalContext = Principal;

export interface McpServerOptions {
  allowUnfiltered?: boolean;
  allowedSourceTables?: ReadonlySet<string>;
  /** Test seam: pre-resolved env vars; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface McpToolResponse<T> {
  result: T;
  permissions: {
    enforced: boolean;
    reason?: 'no_adapter_registered' | 'adapter_does_not_apply';
    adapter?: string;
  };
  citations?: Citation[];
  routing_metadata?: RoutingMetadata;
}

export interface Citation {
  document_id: string;
  document_version_id: string;
  source_uri: string;
  title?: string;
  chunk_id?: string;
  chunk_index?: number;
  page_start?: number;
  page_end?: number;
  section_path?: string;
  event_time?: string;
  mention_id?: string;
  resolved_entity_id?: string;
  /** Drop 7: ACL principals computed at query time via JOIN against __acl. */
  acl_principals: string[];
  source_grant_types: string[];
}

export interface RoutingMetadata {
  resolved_via: 'fts' | 'vector' | 'mention_join' | 'direct';
  cache_hit: boolean;
  embedding_available: boolean;
}

export interface McpServerHooks {
  /**
   * Test seam: receive structured warnings emitted at request boundary.
   * Defaults to a no-op so the server stays silent in production unless a
   * caller opts in (e.g. fmt.error from lib/output/formatter.ts).
   */
  onWarn?: (message: string) => void;
}

export class DogsledMcpServer {
  private readonly allowUnfiltered: boolean;
  private readonly allowedSourceTables: ReadonlySet<string>;
  private readonly warnHook: (message: string) => void;
  private readonly permissionAdapters: PermissionAdapter[] = [];

  constructor(options: McpServerOptions & McpServerHooks = {}) {
    this.allowedSourceTables = new Set(options.allowedSourceTables);
    const env = options.env ?? process.env;
    const flagSet = options.allowUnfiltered === true;
    const envSet = env['DOGSLED_MCP_ALLOW_UNFILTERED'] === '1';
    this.warnHook = options.onWarn ?? (() => undefined);

    if (flagSet !== envSet) {
      throw new CommandError(
        flagSet
          ? '--allow-unfiltered passed but DOGSLED_MCP_ALLOW_UNFILTERED=1 is not set. ' +
              'Both are required to acknowledge the production risk of running without permission enforcement.'
          : 'DOGSLED_MCP_ALLOW_UNFILTERED=1 set but --allow-unfiltered flag is missing. ' +
              'Both are required to acknowledge the production risk of running without permission enforcement.',
        2
      );
    }

    this.allowUnfiltered = flagSet && envSet;
  }

  /**
   * Validate principal presence at request boundary. Throws CommandError(2)
   * when fail-closed default is in effect and no principal is supplied.
   */
  requirePrincipal(principal: PrincipalContext | null | undefined): PrincipalContext | null {
    if (this.allowUnfiltered) {
      this.warnHook(
        '[mcp-server] running with --allow-unfiltered. Permissions are NOT enforced. ' +
          'Connect only public / single-tenant data until Drop 7 lands enforcement.'
      );
      return principal ?? null;
    }
    // Empty / whitespace-only principal_id is treated as missing — silent
    // pass-through would defeat fail-closed posture.
    if (
      !principal ||
      typeof principal.principal_id !== 'string' ||
      principal.principal_id.trim() === ''
    ) {
      throw new CommandError(
        'PermissionsNotConfigured: every MCP tool call requires a principal. ' +
          'Pass --allow-unfiltered AND set DOGSLED_MCP_ALLOW_UNFILTERED=1 to acknowledge the risk ' +
          'and run without enforcement until Drop 7.',
        2
      );
    }
    return principal;
  }

  requireSourcePermission(sourceTable: string, principal: PrincipalContext | null): void {
    if (!this.allowedSourceTables.has(sourceTable)) {
      throw new CommandError('Source table is not declared in this project.', 2);
    }
    if (
      !this.allowUnfiltered &&
      (!principal ||
        !this.permissionAdapters.some((adapter) => adapter.appliesTo({ sourceTable, principal })))
    ) {
      throw new CommandError(
        'PermissionsNotConfigured: a source permission adapter is required.',
        2
      );
    }
  }

  permissionsEnvelope(): McpToolResponse<unknown>['permissions'] {
    return { enforced: false, reason: 'no_adapter_registered' };
  }

  registerPermissionAdapter(adapter: PermissionAdapter): void {
    this.permissionAdapters.push(adapter);
  }

  async applyPermissionAdapters<R>(
    sourceTable: string,
    rows: R[],
    principal: PrincipalContext | null
  ): Promise<{ rows: R[]; permissions: PermissionMetadata }> {
    this.requireSourcePermission(sourceTable, principal);
    if (this.permissionAdapters.length === 0) {
      return { rows, permissions: { enforced: false, reason: 'no_adapter_registered' } };
    }
    if (!principal) {
      return { rows, permissions: { enforced: false, reason: 'adapter_does_not_apply' } };
    }
    const adapter = this.permissionAdapters.find((candidate) =>
      candidate.appliesTo({ sourceTable, principal })
    );
    if (!adapter) {
      return { rows, permissions: { enforced: false, reason: 'adapter_does_not_apply' } };
    }
    return {
      rows: await adapter.filter(rows, { principal }),
      permissions: { enforced: true, adapter: adapter.name },
    };
  }
}
