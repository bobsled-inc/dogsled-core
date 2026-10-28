/**
 * Validate the LLM disambiguator's response against the candidate set.
 *
 * Defense in depth: even with constrained generation (enum-restricted token
 * sampling), post-hoc validate the returned id is in the candidate set.
 * Reject out-of-set responses by returning null (caller marks the mention
 * `unresolved`).
 *
 * Also: NFKC + Unicode-confusable check on the candidate's canonical_name
 * vs the LLM's matched candidate_id surface form. Per CE-Review feedback,
 * this is the candidate-set-poisoning defense (an attacker who plants a
 * homograph entity profile).
 */

import type { Candidate } from '../candidate-retrieval/interface.js';

export interface LlmResolutionInput {
  resolved_entity_id: string;
  confidence: number;
}

export interface ValidatedResolution {
  resolved_entity_id: string;
  entity_type: string;
  confidence: number;
  injection_markers: string[];
}

/** NFKC-fold to match prompt/extract-time normalization; conservative homograph guard. */
function normalize(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/**
 * Returns null when the response is invalid (not in candidate set or
 * UNRESOLVED). Returns a `ValidatedResolution` with injection markers
 * populated when homograph-like surface mismatch is detected.
 *
 * Confidence is required to be a finite number in [0,1] — invalid values
 * collapse to `null` (caller marks the row `unresolved`).
 */
export function validateLlmResolution(
  response: LlmResolutionInput,
  allowed: Candidate[],
  mentionText: string,
  allowedEntityTypes?: readonly string[]
): ValidatedResolution | null {
  if (!response.resolved_entity_id || response.resolved_entity_id === 'UNRESOLVED') {
    return null;
  }
  if (
    typeof response.confidence !== 'number' ||
    !Number.isFinite(response.confidence) ||
    response.confidence < 0 ||
    response.confidence > 1
  ) {
    return null;
  }
  const match = allowed.find((c) => c.entity_id === response.resolved_entity_id);
  if (!match) return null;
  if (
    allowedEntityTypes &&
    allowedEntityTypes.length > 0 &&
    !allowedEntityTypes.includes(match.entity_type)
  ) {
    return null;
  }

  const markers: string[] = [];

  // Unicode-homograph check: if the candidate's canonical_name has the same
  // ASCII-folded form as the mention text but the raw forms differ, flag.
  const mentionFolded = normalize(mentionText);
  const canonicalFolded = normalize(match.canonical_name);
  const sameFolded = mentionFolded === canonicalFolded;
  const sameRaw = mentionText.toLowerCase() === match.canonical_name.toLowerCase();
  if (sameFolded && !sameRaw) {
    markers.push('unicode_homograph');
  }

  return {
    resolved_entity_id: response.resolved_entity_id,
    entity_type: match.entity_type,
    confidence: response.confidence,
    injection_markers: markers,
  };
}
