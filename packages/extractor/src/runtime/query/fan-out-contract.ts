import { serializeErrorCause } from '@bobsled-inc/protocol';

import type { AuthorizeBillableResource } from '../billable-authorization.js';
import type { CustomTokenStore } from '../../framework/runtime/index.js';
import type { IntegrationSpec, ResourceSpec } from '../../types/index.js';
import type { QueryResourceOptions } from './index.js';

/** Version carried by serializable plans and execution results. */
export const QUERY_FAN_OUT_CONTRACT_VERSION = 1 as const;

export interface QueryFanOutBinding {
  field: string;
  input: string;
  source: 'input' | 'output';
}

export interface QueryFanOutPlanNode {
  name: string;
  role: 'root' | 'intermediate' | 'target';
  requiredInputs: string[];
  contextualAncestors: string[];
  effectiveConcurrency: number;
}

export interface QueryFanOutPlanEdge {
  parent: string;
  child: string;
  bindings: QueryFanOutBinding[];
  where?: readonly Record<string, unknown>[];
  effectiveConcurrency: number;
}

/** A portable, JSON-serializable description of one Resource ancestor chain. */
export interface QueryFanOutPlan {
  contractVersion: typeof QUERY_FAN_OUT_CONTRACT_VERSION;
  target: string;
  nodes: QueryFanOutPlanNode[];
  edges: QueryFanOutPlanEdge[];
  /** Root-to-target order. A Resource can have one canonical for_each parent. */
  topologicalOrder: string[];
  requiredRootInputs: string[];
  /** SHA-256 of the canonical target-chain Resource definitions. */
  resourceFingerprint: string;
}

export interface PlanQueryFanOutOptions {
  resources: readonly ResourceSpec[];
  target: string;
  /** Optional transport definition used for pure preflight validation. */
  integration?: IntegrationSpec;
  /** Host policy. Defaults to the public live-query depth cap. */
  maxDepth?: number;
  /** Host policy. Defaults to the public live-query Resource cap. */
  maxResources?: number;
  /** Host concurrency ceiling used to calculate effective edge concurrency. */
  maxConcurrency?: number;
}

export type QueryFanOutPhase = 'plan' | 'parent' | 'child' | 'limit' | 'cancelled';

export interface QueryFanOutCounts {
  parentWorkItems: number;
  targetRows: number;
  providerAttempts: number;
  /** Alias for providerAttempts for host diagnostics. */
  requestCount: number;
  /** Alias for targetRows for host diagnostics. */
  resultCount: number;
  mappedBytes: number;
  maxConcurrency: number;
  durationMs: number;
}

/** Safe error shape intended to cross a host process boundary. */
export class QueryFanOutError extends Error {
  readonly code: string;
  readonly kind: 'auth' | 'validation' | 'provider' | 'timeout' | 'cancellation' | 'internal';
  readonly phase: QueryFanOutPhase;
  readonly target: string;
  readonly resource?: string;
  readonly parentResource?: string;
  readonly binding?: QueryFanOutBinding;
  readonly parentOrdinal?: number;
  readonly counts: QueryFanOutCounts;
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly providerCause?: ReturnType<typeof serializeErrorCause>;
  /** Concrete provider text after the transport's existing redaction/bounds. */
  readonly providerMessage?: string;
  readonly correlationId?: string;

  constructor(options: {
    code: string;
    kind: QueryFanOutError['kind'];
    phase: QueryFanOutPhase;
    target: string;
    message: string;
    counts: QueryFanOutCounts;
    resource?: string;
    parentResource?: string;
    binding?: QueryFanOutBinding;
    parentOrdinal?: number;
    retryable?: boolean;
    providerStatus?: number;
    cause?: unknown;
    correlationId?: string;
  }) {
    super(options.message, { cause: safeNativeCause(options.cause, options.message) });
    this.name = 'QueryFanOutError';
    this.code = options.code;
    this.kind = options.kind;
    this.phase = options.phase;
    this.target = options.target;
    this.resource = options.resource;
    this.parentResource = options.parentResource;
    this.binding = options.binding;
    this.parentOrdinal = options.parentOrdinal;
    this.counts = { ...options.counts };
    this.retryable = options.retryable ?? false;
    this.providerStatus = options.providerStatus;
    const serializedCause = serializeErrorCause(options.cause);
    this.providerMessage = options.cause === undefined ? undefined : options.message;
    this.providerCause =
      serializedCause === undefined
        ? undefined
        : redactSerializedCause(serializedCause, this.providerMessage ?? '[provider error]');
    this.correlationId = options.correlationId;
  }
}

function redactSerializedCause(
  cause: NonNullable<ReturnType<typeof serializeErrorCause>>,
  message: string,
  depth = 0
): NonNullable<ReturnType<typeof serializeErrorCause>> {
  return {
    name: boundedCauseField(cause.name, 64) || 'Error',
    message: depth === 0 ? message : '[redacted provider cause]',
    ...(typeof cause.code === 'number' && Number.isFinite(cause.code)
      ? { code: cause.code }
      : typeof cause.code === 'string'
        ? { code: boundedCauseField(cause.code, 128) }
        : {}),
    ...(cause.status !== undefined ? { status: cause.status } : {}),
    ...(cause.cause ? { cause: redactSerializedCause(cause.cause, message, depth + 1) } : {}),
  };
}

function boundedCauseField(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeNativeCause(cause: unknown, message: string): Error | undefined {
  if (cause === undefined) return undefined;
  const error = cause instanceof Error ? cause : new Error(message);
  return sanitizeErrorInPlace(error, message) ? error : new Error(message);
}

function sanitizeErrorInPlace(
  error: Error,
  message: string,
  depth = 0,
  seen = new WeakSet<Error>()
): boolean {
  if (depth >= 5 || seen.has(error)) return false;
  seen.add(error);
  try {
    Object.defineProperty(error, 'message', {
      value: depth === 0 ? message : '[redacted provider cause]',
      configurable: true,
      writable: true,
    });
    error.name = boundedCauseField(error.name, 64) || 'Error';
    Object.defineProperty(error, 'stack', {
      value: `${error.name}: ${depth === 0 ? message : '[redacted provider cause]'}`,
      configurable: true,
      writable: true,
    });
  } catch {
    return false;
  }
  const safeMetadata = new Set([
    'code',
    'status',
    'kind',
    'phase',
    'target',
    'resource',
    'parentResource',
    'parentOrdinal',
    'counts',
    'retryable',
    'correlationId',
    'stack',
  ]);
  if (error.cause instanceof Error) {
    if (!sanitizeErrorInPlace(error.cause, message, depth + 1, seen)) {
      try {
        Object.defineProperty(error, 'cause', {
          value: new Error('[redacted provider cause]'),
          configurable: true,
          writable: true,
        });
      } catch {
        return false;
      }
    }
  } else if (error.cause !== undefined) {
    try {
      Object.defineProperty(error, 'cause', {
        value: '[REDACTED]',
        configurable: true,
        writable: true,
      });
    } catch {
      return false;
    }
  }
  for (const key of Object.keys(error)) {
    if (safeMetadata.has(key)) continue;
    if (key === 'cause') continue;
    try {
      Object.defineProperty(error, key, {
        value: '[REDACTED]',
        configurable: true,
        writable: true,
        enumerable: true,
      });
    } catch {
      return false;
    }
  }
  return true;
}

export interface QueryFanOutLimits {
  maxParentWorkItems?: number;
  maxTargetRows?: number;
  maxProviderAttempts?: number;
  maxMappedBytes?: number;
  maxConcurrency?: number;
  deadlineMs?: number;
}

export interface QueryResourceFanOutOptions {
  integration: IntegrationSpec;
  resources: readonly ResourceSpec[];
  target: string;
  mode: 'targeted' | 'fan_out';
  input?: Record<string, unknown>;
  filter?: QueryResourceOptions['filter'];
  search?: string;
  limit?: number;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  signal?: AbortSignal;
  limits?: QueryFanOutLimits;
  /** Planning policy used when a precomputed plan was made with a non-default depth cap. */
  maxDepth?: number;
  /** Planning policy used when a precomputed plan was made with a non-default Resource cap. */
  maxResources?: number;
  /** Planning policy used when a precomputed plan was made with a concurrency cap. */
  maxConcurrency?: number;
  authorizeBillable?: AuthorizeBillableResource;
  correlationId?: string;
  /** A caller may plan once and execute that exact public contract. */
  plan?: QueryFanOutPlan;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
}

export interface QueryResourceFanOutResult<TRecord = Record<string, unknown>> {
  contractVersion: typeof QUERY_FAN_OUT_CONTRACT_VERSION;
  plan: QueryFanOutPlan;
  records: TRecord[];
  limitReached: boolean;
  counts: QueryFanOutCounts;
}
