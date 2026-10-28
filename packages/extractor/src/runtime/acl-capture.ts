import type { ListedFile } from '../framework/core/index.js';

/**
 * ACL evidence capture for document resources. Per the Permission Evidence
 * (`__acl`) Contract: Dogsled OSS extracts and stores ACL evidence whenever a
 * source backend exposes it; OSS does NOT enforce.
 *
 * This module owns the normalization layer that translates provider-specific
 * IAM/ACL responses into the normalized `__acl` table shape. Per-provider backends
 * register through `aclBackendFor(integrationKind)`. Backends that don't yet exist
 * return `null`, in which case the document runtime emits an empty `__acl` schema
 * (the contract stays stable for downstream consumers).
 *
 * The schema rows are:
 *   row_id, row_type, principal_id, source_grant_type, source_provider,
 *   captured_at, source_revision
 */

export type AclGrantType =
  | 'iam_role'
  | 'iam_user'
  | 'public'
  | 'file_storage_owner'
  | 'file_storage_group'
  | 'workspace_member'
  | 'shared_link';

export type AclRowType = 'document' | 'chunk';

export interface AclEvidenceRow {
  row_id: string;
  row_type: AclRowType;
  principal_id: string;
  source_grant_type: AclGrantType;
  source_provider: string;
  captured_at: string;
  source_revision?: string;
}

export interface AclBackend {
  /** Provider key — typically the file-storage `source_type` (e.g. `s3`, `gcs`). */
  readonly provider: string;
  /**
   * Capture ACL rows for a single file. Implementations should return an empty array
   * when the backend has no evidence for the file rather than throwing — failures are
   * captured as parse-error rows by the caller, not raised.
   */
  captureForFile(args: {
    documentId: string;
    file: ListedFile;
    bucketOrContainer?: string;
  }): Promise<AclEvidenceRow[]>;
}

const REGISTRY: Map<string, AclBackend> = new Map();

/**
 * Register an ACL backend for a provider. Idempotent — re-registering replaces.
 * Provider backends call this at module load time. v1 ships with no backends; the
 * S3/GCS/SFTP backends land alongside the connection-consolidation work in 1d.
 */
export function registerAclBackend(backend: AclBackend): void {
  REGISTRY.set(backend.provider, backend);
}

export function aclBackendFor(provider: string | undefined): AclBackend | undefined {
  if (!provider) return undefined;
  return REGISTRY.get(provider);
}

/**
 * Whether any backend is registered. Used by the document extraction runtime to skip
 * emitting the `__acl` schema when no provider can produce rows — avoids ghost streams
 * (an `__acl` SCHEMA + zero RECORDs + STATE) for downstream consumers that wire on
 * schema presence.
 */
export function hasRegisteredAclBackends(): boolean {
  return REGISTRY.size > 0;
}
