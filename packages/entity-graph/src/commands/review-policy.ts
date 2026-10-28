import { CommandError } from '@bobsled-inc/protocol';

import { checkApprovalGate } from '../compiler/policy/enforce.js';
import { loadPolicySpec, loadPolicySpecFromFile } from '../compiler/policy/parser.js';

export type ReviewDecisionSource = 'human' | 'agent' | 'system';

export function assertReviewPolicyAllowsDecision(options: {
  specDir?: string;
  policyFile?: string;
  decisionSource: ReviewDecisionSource;
}): void {
  const policySpecDir = options.specDir ?? process.cwd();
  let policyResult: ReturnType<typeof loadPolicySpec>;
  try {
    policyResult = options.policyFile
      ? { spec: loadPolicySpecFromFile(options.policyFile), filePath: options.policyFile }
      : loadPolicySpec(policySpecDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Failed to load policy: ${msg}`, 2, {
      valid: false,
      errorCode: 'REVIEW_POLICY_LOAD_FAILED',
      errors: [{ path: 'policy', message: msg }],
    });
  }

  if (!policyResult) return;

  const gate = checkApprovalGate(policyResult.spec, options.decisionSource);
  if (gate.blocked) {
    const message = gate.reason ?? 'Policy blocked review apply.';
    throw new CommandError(message, 2, {
      valid: false,
      errorCode: 'REVIEW_POLICY_BLOCKED',
      errors: [{ path: 'decisionSource', message }],
    });
  }
}
