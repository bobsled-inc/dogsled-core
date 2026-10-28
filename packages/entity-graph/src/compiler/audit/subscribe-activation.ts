import type { SupportedDialect } from '@bobsled-inc/model-spec';

import { generateAuditInsertSql, ENTITY_GRAPH_SCHEMA } from './codegen.js';
import type { SqlStatement } from '../identity/types.js';

export interface ActivationAuditInput {
  entityId: string;
  clusterId?: string | number;
  syncName: string;
  projectionRef: string;
  status: 'succeeded' | 'failed' | 'skipped';
  idempotencyKey: string;
  action: string;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  dialect: SupportedDialect;
  contractSchema?: string;
}

/**
 * Generate the audit INSERT SQL for an activation dispatch event.
 * Writes category='dispatch', kind='activation_dispatch'.
 */
export function generateActivationDispatchAuditSql(input: ActivationAuditInput): SqlStatement {
  return generateAuditInsertSql({
    name: `audit_activation_dispatch_${input.entityId}`,
    dialect: input.dialect,
    contractSchema: input.contractSchema ?? ENTITY_GRAPH_SCHEMA,
    category: 'dispatch',
    subjectType: 'sync_run',
    subjectId: input.entityId,
    clusterId: input.clusterId != null ? String(input.clusterId) : undefined,
    payload: {
      kind: 'activation_dispatch',
      sync_name: input.syncName,
      projection_version: input.projectionRef,
      action: input.action,
      status: input.status,
    },
    actor: 'system',
    actorType: 'system',
    eventIdDiscriminator: input.idempotencyKey,
  });
}

/**
 * Generate the audit INSERT SQL for an activation receipt event.
 * Writes category='dispatch', kind='activation_receipt'.
 */
export function generateActivationReceiptAuditSql(input: ActivationAuditInput): SqlStatement {
  return generateAuditInsertSql({
    name: `audit_activation_receipt_${input.entityId}`,
    dialect: input.dialect,
    contractSchema: input.contractSchema ?? ENTITY_GRAPH_SCHEMA,
    category: 'dispatch',
    subjectType: 'sync_run',
    subjectId: input.entityId,
    clusterId: input.clusterId != null ? String(input.clusterId) : undefined,
    payload: {
      kind: 'activation_receipt',
      sync_name: input.syncName,
      projection_version: input.projectionRef,
      action: input.action,
      status: input.status,
      duration_ms: input.durationMs,
      error_code: input.errorCode,
    },
    reason: input.errorMessage,
    actor: 'system',
    actorType: 'system',
    eventIdDiscriminator: `receipt-${input.idempotencyKey}`,
  });
}

/**
 * Generate the audit INSERT SQL for a policy block event.
 * Writes category='decision', kind='policy_block'.
 */
export function generatePolicyBlockAuditSql(input: {
  entityId: string;
  clusterId?: string | number;
  policyName: string;
  reason: string;
  dialect: SupportedDialect;
  contractSchema?: string;
}): SqlStatement {
  return generateAuditInsertSql({
    name: `audit_policy_block_${input.entityId}`,
    dialect: input.dialect,
    contractSchema: input.contractSchema ?? ENTITY_GRAPH_SCHEMA,
    category: 'decision',
    subjectType: 'cluster',
    subjectId: input.entityId,
    clusterId: input.clusterId != null ? String(input.clusterId) : undefined,
    payload: {
      kind: 'policy_block',
      policy: input.policyName,
      reason: input.reason,
    },
    reason: input.reason,
    actor: 'system',
    actorType: 'system',
  });
}
