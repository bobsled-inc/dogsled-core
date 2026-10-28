/**
 * Iceberg REST Catalog client.
 *
 * Thin HTTP client wrapping the Iceberg REST Catalog API v1 specification.
 * Handles OAuth2 token acquisition and catalog configuration.
 */

import {
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
  RESPONSE_BODY_LIMITS,
} from '../framework/core/response-body.js';
import { resolveAndValidateHost, safeFetch } from '../framework/core/ssrf.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TableIdentifier {
  namespace: string[];
  name: string;
}

export interface IcebergSchema {
  'schema-id': number;
  fields: Array<{
    id: number;
    name: string;
    type: string | Record<string, unknown>;
    required: boolean;
  }>;
}

export interface LoadTableResponse {
  /** S3/GCS path to the Iceberg metadata.json file */
  metadataLocation: string;
  /** Table metadata including schema */
  metadata: {
    schemas?: IcebergSchema[];
    'current-schema-id'?: number;
  };
  /** Vended credentials from the catalog */
  config?: Record<string, string>;
}

export interface CatalogConfig {
  defaults?: Record<string, string>;
  overrides?: Record<string, string>;
}

export interface IcebergCatalogAuth {
  type: 'oauth2' | 'token';
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  scope?: string;
  token?: string;
}

// ---------------------------------------------------------------------------
// OAuth2 token management
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp (ms)
}

/** Default fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 30_000;

/** Buffer before token expiry to trigger refresh (ms). */
const TOKEN_EXPIRY_BUFFER_MS = 30_000;

async function fetchOAuth2Token(auth: IcebergCatalogAuth): Promise<CachedToken> {
  if (auth.type === 'token') {
    return {
      token: auth.token ?? '',
      // Static tokens never expire in our model
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }

  if (!auth.tokenUrl || !auth.clientId || !auth.clientSecret) {
    throw new Error('OAuth2 auth requires tokenUrl, clientId, and clientSecret');
  }

  // SSRF: validate token URL host before sending credentials
  const tokenHostname = new URL(auth.tokenUrl).hostname;
  await resolveAndValidateHost(tokenHostname, 'Iceberg OAuth2 token URL');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
  });

  if (auth.scope) {
    body.set('scope', auth.scope);
  }

  const response = await safeFetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OAuth2 token request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await readResponseJsonWithLimit(
    response,
    RESPONSE_BODY_LIMITS.token,
    'Iceberg OAuth2 token response'
  )) as TokenResponse;
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('OAuth2 token response did not include access_token');
  }

  // Track expiry: use expires_in if provided, otherwise default to 1 hour.
  // Clamp buffer so short-lived tokens (<30s) don't produce past timestamps
  // that would cause a hot-loop of token refetches.
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  const buffer = Math.min(TOKEN_EXPIRY_BUFFER_MS, expiresInMs / 2);
  const expiresAt = Date.now() + expiresInMs - buffer;

  return { token: data.access_token, expiresAt };
}

// ---------------------------------------------------------------------------
// Catalog client
// ---------------------------------------------------------------------------

export class IcebergCatalogClient {
  private readonly baseUrl: string;
  private readonly warehouse: string | undefined;
  private readonly auth: IcebergCatalogAuth;
  private cachedToken: CachedToken | undefined;

  private constructor(config: {
    catalogUrl: string;
    warehouse?: string;
    auth: IcebergCatalogAuth;
  }) {
    // Normalize base URL: strip trailing slash
    this.baseUrl = config.catalogUrl.replace(/\/+$/, '');
    this.warehouse = config.warehouse;
    this.auth = config.auth;
  }

  /**
   * Create a catalog client with SSRF validation on the catalog URL.
   */
  static async create(config: {
    catalogUrl: string;
    warehouse?: string;
    auth: IcebergCatalogAuth;
  }): Promise<IcebergCatalogClient> {
    const hostname = new URL(config.catalogUrl).hostname;
    await resolveAndValidateHost(hostname, 'Iceberg catalog URL');
    return new IcebergCatalogClient(config);
  }

  private async getToken(): Promise<string> {
    if (!this.cachedToken || Date.now() >= this.cachedToken.expiresAt) {
      this.cachedToken = await fetchOAuth2Token(this.auth);
    }
    return this.cachedToken.token;
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/v1${path}`;

    const response = await safeFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await readResponseTextWithLimit(
        response,
        RESPONSE_BODY_LIMITS.error,
        'Iceberg error response'
      ).catch(() => '');
      throw new Error(
        `Iceberg REST API ${path} failed: ${response.status} ${response.statusText} ${body}`
      );
    }

    // Validate content-type is JSON (skip check if header is absent — some catalogs omit it)
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('json')) {
      throw new Error(`Iceberg REST API ${path} returned unexpected content-type: ${contentType}`);
    }

    const data = await readResponseJsonWithLimit(
      response,
      RESPONSE_BODY_LIMITS.iceberg,
      'Iceberg REST response'
    );

    // Basic shape validation: response should be a non-null object
    if (data === null || typeof data !== 'object') {
      throw new Error(`Iceberg REST API ${path} returned invalid response shape`);
    }

    return data as T;
  }

  /**
   * Get catalog configuration (defaults and overrides).
   */
  async getConfig(): Promise<CatalogConfig> {
    const params = this.warehouse ? `?warehouse=${encodeURIComponent(this.warehouse)}` : '';
    return this.request<CatalogConfig>(`/config${params}`);
  }

  /**
   * List namespaces in the catalog.
   */
  async listNamespaces(parent?: string[]): Promise<string[][]> {
    const parentParam =
      parent && parent.length > 0 ? `?parent=${encodeURIComponent(parent.join('\x1F'))}` : '';
    const result = await this.request<{ namespaces: string[][] }>(`/namespaces${parentParam}`);
    return result.namespaces;
  }

  /**
   * List tables within a namespace.
   */
  async listTables(namespace: string[]): Promise<TableIdentifier[]> {
    const nsPath = namespace.map(encodeURIComponent).join('%1F');
    const result = await this.request<{ identifiers: TableIdentifier[] }>(
      `/namespaces/${nsPath}/tables`
    );
    return result.identifiers;
  }

  /**
   * Load a table's metadata and optionally vended credentials.
   *
   * The response includes `metadataLocation` (path to metadata.json)
   * and `config` with vended storage credentials.
   */
  async loadTable(namespace: string[], table: string): Promise<LoadTableResponse> {
    const nsPath = namespace.map(encodeURIComponent).join('%1F');
    const tablePath = encodeURIComponent(table);
    const result = await this.request<{
      'metadata-location': string;
      metadata: LoadTableResponse['metadata'];
      config?: Record<string, string>;
    }>(`/namespaces/${nsPath}/tables/${tablePath}`);

    return {
      metadataLocation: result['metadata-location'],
      metadata: result.metadata,
      config: result.config,
    };
  }

  /**
   * Clear the cached OAuth2 token (e.g. on auth failure).
   */
  clearTokenCache(): void {
    this.cachedToken = undefined;
  }
}
