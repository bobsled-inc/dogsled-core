import type { PolicySpec } from './schema.js';

export type ResolvedPolicy = PolicySpec;

export interface TrustGateResult {
  passed: boolean;
  entityId: string;
  entityTrustScore: number;
  threshold: number;
}

export interface ApprovalGateResult {
  blocked: boolean;
  reason?: string;
}
