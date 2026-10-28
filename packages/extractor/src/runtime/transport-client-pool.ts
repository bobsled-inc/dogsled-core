import * as path from 'node:path';

import {
  getErrorMessage,
  isSourceSpec,
  isSqlTransport,
  resolveVia,
} from '../framework/core/index.js';
import { buildApiIntegrationSpec } from './api-integration-spec.js';
import { ExtractorClient } from './client.js';
import { ExtractorConfigError } from './errors.js';
import { McpExtractorClient } from './mcp-client.js';

import type { TransportConfig } from '../framework/core/index.js';
import type { ApiIntegrationSpec, ApiResourceSpec, IntegrationSpec } from '../types/index.js';

export type ExtractRuntimeClient = ExtractorClient | McpExtractorClient;

export interface TransportClientPoolOptions {
  integration: IntegrationSpec;
  cliInputs?: Record<string, unknown>;
  stateDir: string;
}

export interface ResolvedTransportClient {
  client: ExtractRuntimeClient;
  integration: ApiIntegrationSpec;
  transportId: string;
  transportType: TransportConfig['type'];
}

export class TransportClientPool {
  private readonly integration: IntegrationSpec;
  private readonly cliInputs: Record<string, unknown>;
  private readonly stateDir: string;
  private readonly clients = new Map<string, ExtractRuntimeClient>();
  private readonly pendingClients = new Map<string, Promise<ExtractRuntimeClient>>();

  constructor(options: TransportClientPoolOptions) {
    this.integration = options.integration;
    this.cliInputs = options.cliInputs ?? {};
    this.stateDir = options.stateDir;
  }

  async getForResource(resource: ApiResourceSpec): Promise<ResolvedTransportClient> {
    const resolved = resolveApiTransport(this.integration, resource);
    const cacheKey = `${resolved.integration.name}:${resolved.transportId}`;
    const existing = this.clients.get(cacheKey);
    if (existing) {
      return {
        client: existing,
        integration: resolved.integration,
        transportId: resolved.transportId,
        transportType: resolved.integration.transport.type,
      };
    }

    const pending = this.pendingClients.get(cacheKey);
    if (pending) {
      const client = await pending;
      return {
        client,
        integration: resolved.integration,
        transportId: resolved.transportId,
        transportType: resolved.integration.transport.type,
      };
    }

    const createClient = this.createClient(resolved);
    this.pendingClients.set(cacheKey, createClient);
    let client: ExtractRuntimeClient;
    try {
      client = await createClient;
    } finally {
      this.pendingClients.delete(cacheKey);
    }

    return {
      client,
      integration: resolved.integration,
      transportId: resolved.transportId,
      transportType: resolved.integration.transport.type,
    };
  }

  async closeAll(): Promise<void> {
    const pendingResults = await Promise.allSettled(this.pendingClients.values());
    this.pendingClients.clear();

    const clients = new Set(this.clients.values());
    for (const result of pendingResults) {
      if (result.status === 'fulfilled') {
        clients.add(result.value);
      }
    }
    this.clients.clear();
    const closeResults = await Promise.allSettled([...clients].map((client) => client.close()));
    const failures = [...pendingResults, ...closeResults]
      .filter((result) => result.status === 'rejected')
      .map((result) => getErrorMessage(result.reason));
    if (failures.length > 0) {
      process.emitWarning(
        `${failures.length} transport client cleanup operation(s) failed: ${failures.join('; ')}`,
        {
          type: 'DogsledExtractorWarning',
        }
      );
    }
  }

  private async createClient(resolved: ResolvedApiTransport): Promise<ExtractRuntimeClient> {
    const scopedStateDir = path.join(
      this.stateDir,
      'transports',
      sanitizePathSegment(resolved.transportId)
    );
    const client =
      resolved.integration.transport.type === 'http'
        ? new ExtractorClient({
            integration: resolved.integration,
            cliInputs: this.cliInputs,
            stateDir: scopedStateDir,
          })
        : new McpExtractorClient({
            integration: resolved.integration,
            cliInputs: this.cliInputs,
          });

    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }

    const cacheKey = `${resolved.integration.name}:${resolved.transportId}`;
    this.clients.set(cacheKey, client);
    return client;
  }
}

interface ResolvedApiTransport {
  integration: ApiIntegrationSpec;
  transportId: string;
}

export function resolveApiTransport(
  integration: IntegrationSpec,
  resource: ApiResourceSpec
): ResolvedApiTransport {
  if (isSourceSpec(integration)) {
    const transport = resolveVia(integration, resource.via);
    if (isSqlTransport(transport)) {
      throw new ExtractorConfigError(
        `Resource "${resource.name}" resolves via SQL transport "${transport.id}", which is not executable by the API extractor runtime.`
      );
    }
    return {
      integration: buildApiIntegrationSpec(integration, transport),
      transportId: transport.id,
    };
  }

  if (!('transport' in integration)) {
    throw new ExtractorConfigError(
      `Integration "${integration.name}" is not an API/source integration and cannot extract resource "${resource.name}".`
    );
  }

  return {
    integration,
    transportId: 'default',
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}
