import * as http from 'node:http';
import * as dns from 'node:dns/promises';
import * as https from 'node:https';
import { connect as connectSocket, isIP, type LookupFunction, type Socket } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateHost } from './shared.js';

const originalGlobalFetch = globalThis.fetch;
type LookupAllHost = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookupAllHost: LookupAllHost = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results;
};
let lookupAllHost: LookupAllHost = defaultLookupAllHost;

export function setDnsLookupForTests(
  nextLookup: (hostname: string) => Promise<{ address: string; family: number }>
): void {
  lookupAllHost = async (hostname) => [await nextLookup(hostname)];
}

export function resetDnsLookupForTests(): void {
  lookupAllHost = defaultLookupAllHost;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function privateHostError(label: string, hostname: string, address?: string): Error {
  return address
    ? new Error(`${label} hostname "${hostname}" resolves to private address ${address}.`)
    : new Error(`${label} hostname "${hostname}" is a private/internal host.`);
}

function assertPublicAddress(hostname: string, address: string, label: string): void {
  if (isPrivateHost(address)) {
    throw privateHostError(label, hostname, address);
  }
}

async function resolveValidatedAddresses(
  hostname: string,
  label: string
): Promise<Array<{ address: string; family: number }>> {
  const normalized = stripIpv6Brackets(hostname);
  if (isPrivateHost(normalized)) {
    throw privateHostError(label, hostname);
  }

  const literalFamily = isIP(normalized);
  if (literalFamily !== 0) {
    return [{ address: normalized, family: literalFamily }];
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookupAllHost(normalized);
  } catch {
    throw new Error(`${label} hostname "${hostname}" could not be resolved for SSRF validation.`);
  }
  if (answers.length === 0) {
    throw new Error(`${label} hostname "${hostname}" returned no addresses for SSRF validation.`);
  }
  for (const { address } of answers) {
    assertPublicAddress(hostname, address, label);
  }
  return answers;
}

/**
 * Resolve hostnames before issuing network requests so private-address answers
 * are rejected even when the original hostname looks public.
 */
export async function resolveAndValidateHost(hostname: string, label: string): Promise<void> {
  // Preserve the legacy explicit opt-in semantics for preflight validation.
  // Actual safeFetch sockets still resolve through safeLookup, where metadata
  // and link-local answers remain blocked.
  if (process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] === '1') {
    return;
  }
  await resolveValidatedAddresses(hostname, label);
}

/**
 * The lookup hook is invoked by `net.connect` for the actual socket, eliminating
 * the validate-then-resolve DNS-rebinding window. All returned answers are
 * checked and only validated addresses are handed to the connector.
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  void resolveValidatedAddresses(hostname, 'Request URL')
    .then((answers) => {
      const requestedFamily =
        typeof options === 'object' && typeof options.family === 'number' ? options.family : 0;
      const compatible =
        requestedFamily === 4 || requestedFamily === 6
          ? answers.filter(({ family }) => family === requestedFamily)
          : answers;
      if (compatible.length === 0) {
        const error = new Error(
          `Request URL hostname "${hostname}" has no address for family ${requestedFamily}.`
        ) as NodeJS.ErrnoException;
        error.code = 'ENOTFOUND';
        callback(error, '');
        return;
      }

      if (typeof options === 'object' && options.all) {
        callback(null, compatible);
        return;
      }
      const selected = compatible[0]!;
      callback(null, selected.address, selected.family);
    })
    .catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)), '');
    });
};

/**
 * Create a Node HTTP agent that validates DNS answers at socket-connection time.
 * HTTPS agents also receive the configured CA because @clickhouse/client ignores
 * its TLS options when a custom agent is supplied.
 */
export function createSafeHttpAgent(useTls: boolean, caCert?: string): http.Agent | https.Agent {
  const agentOptions: http.AgentOptions = {
    keepAlive: true,
    lookup: safeLookup,
  };
  if (!useTls) {
    return new http.Agent(agentOptions);
  }

  return new https.Agent({
    ...agentOptions,
    ...(caCert ? { ca: Buffer.from(caCert) } : {}),
  });
}

const safeHttpDispatcher = new Agent({
  connect: {
    lookup: safeLookup,
  },
});

/**
 * Open a raw TCP socket with the same connection-time DNS validation used by
 * safeFetch. This is for protocols such as SFTP whose client accepts an
 * already-connected socket but does not expose a DNS lookup hook.
 */
export async function connectToValidatedHost(
  hostname: string,
  port: number,
  timeoutMs = 30_000
): Promise<Socket> {
  if (isPrivateHost(hostname)) {
    throw privateHostError('Connection', hostname);
  }

  return await new Promise<Socket>((resolve, reject) => {
    const socket = connectSocket({ host: hostname, port, lookup: safeLookup });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to "${hostname}:${port}" timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Fetch through an Undici dispatcher that validates DNS at socket connection
 * time. Redirects default to manual so callers must explicitly validate or
 * reject each hop instead of silently crossing the network trust boundary.
 */
export const safeFetch: typeof globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Request URL must use HTTP or HTTPS; received ${url.protocol}`);
  }
  if (isPrivateHost(url.hostname)) {
    throw privateHostError('Request URL', url.hostname);
  }

  const useTestDouble =
    process.env['VITEST'] === 'true' && globalThis.fetch !== originalGlobalFetch;
  const fetchImpl = useTestDouble
    ? globalThis.fetch
    : (undiciFetch as unknown as typeof globalThis.fetch);
  const requestInit = {
    ...init,
    redirect: init?.redirect ?? 'manual',
    dispatcher: safeHttpDispatcher,
  } as RequestInit & { dispatcher: Agent };

  // Test doubles are intentionally not handed a real dispatcher. Production
  // requests always use Undici's fetch + Agent pair from the same package,
  // ensuring the connection-time lookup hook is compatible with the client.
  return await fetchImpl(
    input,
    useTestDouble
      ? {
          ...init,
          redirect: init?.redirect ?? 'manual',
        }
      : requestInit
  );
};
