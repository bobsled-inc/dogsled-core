export interface AuditEmitInput {
  category: 'mutation' | 'decision' | 'dispatch';
  subjectType: string;
  subjectId: string;
  payload: unknown;
  reason?: string;
  actor?: string;
  actorType?: 'human' | 'agent' | 'system';
}

export interface AuditEmitResult extends AuditEmitInput {
  actor: string;
  actorType: 'human' | 'agent' | 'system';
  occurredAt: string;
}

export function buildAuditEvent(input: AuditEmitInput): AuditEmitResult {
  return {
    ...input,
    actor: input.actor ?? 'system',
    actorType: input.actorType ?? 'system',
    occurredAt: new Date().toISOString(),
  };
}
