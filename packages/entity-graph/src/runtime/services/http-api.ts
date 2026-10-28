import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import type { QueryableRunner } from '../../api/extract-project-utils.js';
import type { ResolvedResolutionSpec } from '../../compiler/identity/types.js';
import { getEntity, getRelationships, listEntities, specSearchConfig } from './entity-read.js';
import { assignMatch, lookupMatch, stageMatch } from './match.js';

export interface EntityGraphHttpServerOptions {
  runner: QueryableRunner;
  schema: string;
  dialect: SupportedDialect;
  specs: readonly ResolvedResolutionSpec[];
  host?: string;
  port: number;
  allowRemote?: boolean;
  allowWrites?: boolean;
}

export interface StartedEntityGraphHttpServer {
  server: Server;
  url: string;
  ready: Promise<void>;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(
    JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}

function pathParts(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter((part) => part.length > 0)
    .map(decodeURIComponent);
}

const MAX_REQUEST_BODY_BYTES = 1_048_576;

function normalizedHostName(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const colonCount = [...trimmed].filter((char) => char === ':').length;
  if (colonCount === 1) return trimmed.split(':')[0] ?? '';
  return trimmed;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizedHostName(host);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isWildcardHost(host: string): boolean {
  const normalized = normalizedHostName(host);
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '';
}

function headerSourceHost(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  try {
    const source = new URL(raw);
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== raw) return undefined;
    return source.host;
  } catch {
    return undefined;
  }
}

function rejectUnsafeLocalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  allowRemote: boolean
): boolean {
  const host = request.headers.host ?? '';
  if (!allowRemote && !isLoopbackHost(host)) {
    sendJson(response, 403, { error: 'Host must be localhost, 127.0.0.1, or [::1].' });
    return true;
  }
  const method = request.method ?? 'GET';
  if (method !== 'GET') {
    const sourceHost = headerSourceHost(request.headers.origin);
    if (!sourceHost || sourceHost !== host) {
      sendJson(response, 403, { error: 'Cross-origin mutating requests are rejected.' });
      return true;
    }
    if (
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    ) {
      sendJson(response, 415, { error: 'JSON content type required.' });
      return true;
    }
  }
  return false;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new CommandError('Request body exceeds 1 MiB.', 2);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Request body must be valid JSON: ${message}`, 2);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandError('Request body must be a JSON object.', 2);
  }
  return value as Record<string, unknown>;
}

function openApi(host: string, port: number): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Dogsled Entity Graph API', version: '1.0.0' },
    servers: [{ url: `http://${host}:${port}` }],
    paths: {
      '/healthz': { get: { responses: { '200': { description: 'OK' } } } },
      '/entities/{type}': { get: { responses: { '200': { description: 'Entity search' } } } },
      '/entities/{type}/{id}': { get: { responses: { '200': { description: 'Entity get' } } } },
      '/entities/{type}/match': { post: { responses: { '200': { description: 'Entity match' } } } },
      '/entities/{type}/{id}/relationships': {
        get: { responses: { '200': { description: 'Entity relationships' } } },
      },
    },
  };
}

export function startEntityGraphHttpServer(
  options: EntityGraphHttpServerOptions
): StartedEntityGraphHttpServer {
  const host = options.host ?? '127.0.0.1';
  let actualPort = options.port;
  const specByEntity = new Map(options.specs.map((spec) => [spec.entity, spec]));
  const baseContext = { runner: options.runner, schema: options.schema, dialect: options.dialect };
  const server = createServer(async (request, response) => {
    try {
      if (rejectUnsafeLocalRequest(request, response, options.allowRemote === true)) return;
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? `${host}:${actualPort}`}`
      );
      const parts = pathParts(url);
      const method = request.method ?? 'GET';

      if (method === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === 'GET' && parts.length === 1 && parts[0] === 'openapi.json') {
        sendJson(response, 200, openApi(host, actualPort));
        return;
      }
      if (parts[0] !== 'entities' || !parts[1]) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const entity = parts[1];
      if (method === 'GET' && parts.length === 2) {
        const spec = specByEntity.get(entity);
        const result = await listEntities(baseContext, {
          entity,
          query: url.searchParams.get('query') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          ...(spec ? { search: specSearchConfig(spec) } : {}),
        });
        sendJson(response, 200, result);
        return;
      }
      if (method === 'GET' && parts.length === 3) {
        const entityId = parts[2];
        if (!entityId) {
          sendJson(response, 404, { error: 'Not found' });
          return;
        }
        const result = await getEntity(baseContext, { entity, entityId });
        sendJson(response, result ? 200 : 404, result ?? { error: 'Not found' });
        return;
      }
      if (method === 'GET' && parts.length === 4 && parts[3] === 'relationships') {
        const entityId = parts[2];
        if (!entityId) {
          sendJson(response, 404, { error: 'Not found' });
          return;
        }
        const result = await getRelationships(baseContext, {
          entity,
          entityId,
          relation: url.searchParams.get('relation') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
        });
        sendJson(response, 200, result);
        return;
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'match') {
        const body = asRecord(await readBody(request));
        const record = asRecord(body['record']);
        const mode = body['mode'] === undefined ? 'lookup' : body['mode'];
        if (mode !== 'lookup' && mode !== 'assign' && mode !== 'stage') {
          throw new CommandError('mode must be lookup, assign, or stage.', 2);
        }
        if ((mode === 'assign' || mode === 'stage') && !options.allowWrites) {
          throw new CommandError('assign/stage require --allow-writes.', 2);
        }
        const spec = specByEntity.get(entity);
        if (!spec) throw new CommandError(`No entity spec found for '${entity}'.`, 2);
        const context = { ...baseContext, spec };
        const result =
          mode === 'assign'
            ? await assignMatch(context, record)
            : mode === 'stage'
              ? await stageMatch(context, record)
              : await lookupMatch(context, record);
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof CommandError && error.exitCode === 2 ? 400 : 500;
      sendJson(response, status, {
        error:
          error instanceof CommandError && error.exitCode === 2
            ? error.message
            : 'Internal server error',
      });
    }
  });
  const started: StartedEntityGraphHttpServer = {
    server,
    url: `http://${host}:${actualPort}`,
    ready: Promise.resolve(),
  };
  const updateBoundUrl = () => {
    const address = server.address();
    actualPort =
      address && typeof address === 'object' && typeof address.port === 'number'
        ? address.port
        : options.port;
    started.url = `http://${host}:${actualPort}`;
  };
  started.ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      updateBoundUrl();
      resolve();
    });
    server.once('error', (error) => {
      reject(
        new CommandError(
          `Failed to start entity graph HTTP server: ${error instanceof Error ? error.message : String(error)}`,
          1
        )
      );
    });
  });
  server.listen(options.port, host);
  updateBoundUrl();
  return started;
}
