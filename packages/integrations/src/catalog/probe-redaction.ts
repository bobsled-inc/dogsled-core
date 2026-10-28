import type { CatalogProbeAuth } from './probe-types.js';
import { buildAutomaton, scanAutomaton } from './probe-redaction-automaton.js';

const CREDENTIAL_NAME_RE =
  /(?:auth|token|secret|password|api[-_]?key|credential|cookie|signature)/i;
const CREDENTIAL_KEY_NAMES = new Set([
  'access_key_id',
  'client_id',
  'key',
  'refresh_token',
  'secret_access_key',
  'session_token',
  'username',
]);

const MAX_REDACTION_VALUES = 256;
const MAX_REDACTION_VALUE_BYTES = 4 * 1024;
const MAX_REDACTION_TOTAL_BYTES = 64 * 1024;
const MAX_REDACTION_NODES = 32 * 1024;

interface RedactionState {
  values: Set<string>;
  totalBytes: number;
  visitedNodes: number;
}

export interface ProbeRedactionRequest {
  authorization: CatalogProbeAuth;
  headers: Readonly<Record<string, string>>;
  url: string;
  body?: string;
}

export interface ProbeRedactionPlan {
  readonly maxPatternBytes: number;
  redactBytes(bytes: Uint8Array, outputLimit?: number, protectCutoff?: boolean): Uint8Array;
  redactText(value: string): string;
}

const textEncoder = new TextEncoder();

function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME_RE.test(name) || CREDENTIAL_KEY_NAMES.has(name.toLowerCase());
}

function addSecret(state: RedactionState, value: string): boolean {
  if (value.length === 0 || state.values.has(value)) return true;
  // UTF-8 byte length is never smaller than the JavaScript UTF-16 code-unit
  // length, so this cheap check avoids allocating for obviously oversized
  // untrusted literals.
  if (value.length > MAX_REDACTION_VALUE_BYTES) return false;
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength > MAX_REDACTION_VALUE_BYTES) return false;
  if (state.values.size >= MAX_REDACTION_VALUES) return false;
  if (state.totalBytes + bytes.byteLength > MAX_REDACTION_TOTAL_BYTES) return false;
  state.values.add(value);
  state.totalBytes += bytes.byteLength;
  return true;
}

function visitNode(state: RedactionState): boolean {
  state.visitedNodes += 1;
  return state.visitedNodes <= MAX_REDACTION_NODES;
}

function collectAuthCredentials(auth: CatalogProbeAuth, state: RedactionState): boolean {
  switch (auth.type) {
    case 'none':
      return true;
    case 'bearer':
      return addSecret(state, auth.token);
    case 'api-key':
      return addSecret(state, auth.key);
    case 'basic':
      return addSecret(state, auth.username) && addSecret(state, auth.password);
    case 'oauth2':
      if (!addSecret(state, auth.client_id) || !addSecret(state, auth.client_secret)) {
        return false;
      }
      return auth.grant_type === 'authorization_code' ? addSecret(state, auth.refresh_token) : true;
    case 'custom-token':
      // A custom token request is an opaque credential exchange. Its caller
      // chooses the header names and body shape, so generic fields such as
      // `X-Custom` and `value` are sensitive just like `api_key`.
      return (
        collectCredentialValues(auth.token_request?.headers, state, true) &&
        collectCredentialValues(auth.token_request?.body, state, true)
      );
    case 'aws-sigv4':
      return (
        addSecret(state, auth.access_key_id) &&
        addSecret(state, auth.secret_access_key) &&
        (auth.session_token === undefined || addSecret(state, auth.session_token))
      );
  }
}

function collectCredentialHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  state: RedactionState
): boolean {
  if (!headers) return true;
  for (const name in headers) {
    if (!Object.hasOwn(headers, name)) continue;
    const value = headers[name] as string;
    if (isCredentialName(name) && !addSecret(state, value)) return false;
  }
  return true;
}

function collectCredentialValues(
  value: unknown,
  state: RedactionState,
  credential: boolean
): boolean {
  const pending: Array<{ value: unknown; credential: boolean }> = [{ value, credential }];

  while (pending.length > 0) {
    const current = pending.pop() as { value: unknown; credential: boolean };
    if (!visitNode(state)) return false;

    if (typeof current.value === 'string') {
      if (current.credential && !addSecret(state, current.value)) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (pending.length + current.value.length > MAX_REDACTION_NODES) return false;
      for (const item of current.value) {
        pending.push({ value: item, credential: current.credential });
      }
      continue;
    }
    if (typeof current.value !== 'object' || current.value === null) continue;
    const objectValue = current.value as Record<string, unknown>;
    for (const key in objectValue) {
      if (!Object.hasOwn(objectValue, key)) continue;
      if (pending.length >= MAX_REDACTION_NODES) return false;
      pending.push({
        value: objectValue[key],
        credential: current.credential || isCredentialName(key),
      });
    }
  }
  return true;
}

function createState(
  values: Readonly<Record<string, string | undefined>> | undefined
): RedactionState | undefined {
  const state: RedactionState = { values: new Set(), totalBytes: 0, visitedNodes: 0 };
  for (const key in values ?? {}) {
    if (!Object.hasOwn(values ?? {}, key)) continue;
    const value = values?.[key];
    if (value !== undefined && (typeof value !== 'string' || !addSecret(state, value))) {
      return undefined;
    }
  }
  return state;
}

function collectRequestSecrets(request: ProbeRedactionRequest, state: RedactionState): boolean {
  if (!collectAuthCredentials(request.authorization, state)) return false;
  if (!collectCredentialHeaders(request.headers, state)) return false;

  try {
    const requestUrl = new URL(request.url);
    for (const [name, value] of requestUrl.searchParams.entries()) {
      if (isCredentialName(name) && !addSecret(state, value)) return false;
    }
  } catch {
    return false;
  }

  if (request.body !== undefined) {
    try {
      if (!collectCredentialValues(JSON.parse(request.body), state, false)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function createByteRedactor(patterns: readonly Uint8Array[]): {
  maxPatternBytes: number;
  redact(bytes: Uint8Array, outputLimit: number, protectCutoff?: boolean): Uint8Array;
} {
  const nodes = buildAutomaton(patterns.map((pattern) => Array.from(pattern)));
  const maxPatternBytes = patterns.reduce(
    (maximum, pattern) => Math.max(maximum, pattern.byteLength),
    0
  );

  return {
    maxPatternBytes,
    redact(bytes, outputLimit, protectCutoff) {
      const result = bytes.slice();
      const limit = Math.min(outputLimit, bytes.byteLength);
      const mask = (start: number, end: number) => {
        const boundedStart = Math.max(0, start);
        const boundedEnd = Math.min(limit, end);
        if (boundedStart < boundedEnd) result.fill(0x2a, boundedStart, boundedEnd);
      };

      const prefixLength = scanAutomaton(
        nodes,
        bytes.byteLength,
        (index) => bytes[index] as number,
        (start, end) => mask(start, end)
      );
      if (protectCutoff && prefixLength > 0) {
        mask(bytes.byteLength - prefixLength, bytes.byteLength);
      }
      return result;
    },
  };
}

function createTextRedactor(patterns: readonly string[]): (value: string) => string {
  const codeUnitPatterns = patterns.map((pattern) => {
    const codeUnits: number[] = [];
    for (let index = 0; index < pattern.length; index += 1) {
      codeUnits.push(pattern.charCodeAt(index));
    }
    return codeUnits;
  });
  const nodes = buildAutomaton(codeUnitPatterns);

  return (value) => {
    if (value.length === 0 || patterns.length === 0) return value;
    const mask = new Uint8Array(value.length);
    scanAutomaton(
      nodes,
      value.length,
      (index) => value.charCodeAt(index),
      (start, end) => mask.fill(1, Math.max(0, start), Math.min(value.length, end))
    );

    let redacted = '';
    let index = 0;
    while (index < value.length) {
      if (mask[index] === 0) {
        redacted += value[index];
        index += 1;
        continue;
      }
      redacted += '[REDACTED]';
      while (index < value.length && mask[index] !== 0) index += 1;
    }
    return redacted;
  };
}

export function buildProbeRedactionPlan(input: {
  secrets?: Readonly<Record<string, string | undefined>>;
  env?: Readonly<Record<string, string | undefined>>;
  additionalSecrets?: readonly string[];
  request: ProbeRedactionRequest;
}): ProbeRedactionPlan | undefined {
  const state = createState(input.secrets);
  if (!state) return undefined;
  for (const key in input.env ?? {}) {
    if (!Object.hasOwn(input.env ?? {}, key)) continue;
    const value = input.env?.[key];
    if (value !== undefined && (typeof value !== 'string' || !addSecret(state, value))) {
      return undefined;
    }
  }
  for (const value of input.additionalSecrets ?? []) {
    if (typeof value !== 'string' || !addSecret(state, value)) return undefined;
  }

  if (!collectRequestSecrets(input.request, state)) return undefined;

  const values = [...state.values];
  const bytePatterns = values.map((value) => textEncoder.encode(value));
  const byteRedactor = createByteRedactor(bytePatterns);
  const textRedactor = createTextRedactor(values);

  return {
    maxPatternBytes: byteRedactor.maxPatternBytes,
    redactBytes: (bytes, outputLimit = bytes.byteLength, protectCutoff = false) =>
      byteRedactor.redact(bytes, outputLimit, protectCutoff),
    redactText: textRedactor,
  };
}

export interface ProbeRedactedResponse {
  status: number;
  contentType: string | null;
  responseBytes: Uint8Array;
  truncated: boolean;
}

export async function readBoundedProbeResponse(
  response: Response,
  maxBytes: number,
  redaction: ProbeRedactionPlan
): Promise<ProbeRedactedResponse> {
  // Read enough overlap to identify a credential that begins before the
  // returned boundary, while remaining bounded by the validated pattern cap.
  const scanBytes = maxBytes + redaction.maxPatternBytes;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let stoppedEarly = false;

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        const remaining = scanBytes - size;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) chunks.push(chunk.slice(0, remaining));
          size = scanBytes;
          truncated = true;
          stoppedEarly = true;
          await reader.cancel();
          break;
        }
        if (chunk.byteLength > 0) chunks.push(chunk);
        size += chunk.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const redacted = redaction.redactBytes(body, maxBytes, stoppedEarly);
  const contentType = response.headers.get('content-type');
  return {
    status: response.status,
    contentType: contentType === null ? null : redaction.redactText(contentType),
    responseBytes: redacted.slice(0, maxBytes),
    truncated: truncated || body.byteLength > maxBytes,
  };
}
