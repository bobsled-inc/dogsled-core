import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import YAML from 'yaml';

import { requestClaudeJson } from '@/lib/claude-json';
import {
  collectOutput,
  formatEntityGraphTableName,
  getEntityGraphRunnerPath,
  spawnEntityGraphCommand,
  specYamlPath,
  withEntityGraphWorkspaceQuery,
} from '@/lib/entity-graph-workspace';
import {
  buildEntityGraphCompareFields,
  buildEntityGraphCompareSelectList,
  buildEntityGraphFeatureContributions,
  type EntityGraphCompareFieldValue,
  type EntityGraphEntityDefinition,
  type EntityGraphEntityId,
  type EntityGraphFeatureContribution,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { logServerError } from '@/lib/server-logging';
import { buildEntityGraphQueueStatusClause } from '@/lib/entity-graph-review-status';
import type { EntityGraphReviewPairSqlRow } from '@/lib/entity-graph-queue-rows';
import {
  buildAgentProposalDecisionRows,
  buildAgentReviewSampleResult,
  CLAUDE_AGENT_DECISION_SOURCE,
  clampAgentSampleLimit,
  parseClaudeAgentAssessmentPayload,
  type ClaudeAgentAssessment,
} from '@/lib/entity-graph-agent-sample';
import type { AgentReviewTaskResult } from '@/lib/entity-graph-agent-review';

export interface AgentReviewCandidate {
  pair_id: string;
  record_a_id: string | null;
  record_b_id: string | null;
  source_a: string | null;
  source_b: string | null;
  composite_score: number;
  threshold_band: string;
  recommended_action: string | null;
  compare_fields: EntityGraphCompareFieldValue[];
  feature_contributions: EntityGraphFeatureContribution[];
}

export type RedactedAgentReviewFieldState =
  'exact_match' | 'different' | 'record_a_missing' | 'record_b_missing' | 'both_missing';

export interface AgentReviewPromptCompareField {
  key: string;
  label: string;
  a: string | null;
  b: string | null;
  state: RedactedAgentReviewFieldState;
}

export interface AgentReviewPromptFeatureContribution {
  key: string;
  label: string;
  score: number | null;
  a: string | null;
  b: string | null;
}

export interface AgentReviewPromptCandidate {
  pair_id: string;
  source_a: string | null;
  source_b: string | null;
  composite_score: number;
  threshold_band: string;
  recommended_action: string | null;
  compare_fields: AgentReviewPromptCompareField[];
  feature_contributions: AgentReviewPromptFeatureContribution[];
}

export class InvalidAgentAssessmentPayloadError extends Error {
  constructor() {
    super('Agent review returned an invalid response.');
    this.name = 'InvalidAgentAssessmentPayloadError';
  }
}

export interface AgentReviewSampleOutcome {
  result: AgentReviewTaskResult;
  assessments: ClaudeAgentAssessment[];
}

export interface RunClaudeAgentReviewSampleOptions {
  scenarioId: EntityGraphScenarioId;
  entityId: EntityGraphEntityId;
  entity: EntityGraphEntityDefinition;
  limit: number;
}

async function loadAgentReviewCandidates(
  scenarioId: EntityGraphScenarioId,
  entityId: EntityGraphEntityId,
  entity: EntityGraphEntityDefinition,
  limit: number
): Promise<AgentReviewCandidate[]> {
  const safeLimit = clampAgentSampleLimit(limit);
  const compareSelect = buildEntityGraphCompareSelectList(entity, 'sa', 'a')
    .concat(buildEntityGraphCompareSelectList(entity, 'sb', 'b'))
    .join(',\n        ');
  const statusClause = buildEntityGraphQueueStatusClause('open');
  const sql = `
    WITH latest_decisions AS (
      SELECT pair_id, decision, status AS decision_status,
        ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY decided_at DESC, applied_at DESC) AS rn
      FROM ${formatEntityGraphTableName(entityId, '__review_decisions', scenarioId)}
    )
    SELECT
      rq.pair_id,
      rq.record_a_id,
      rq.record_b_id,
      rq.source_a,
      rq.source_b,
      rq.composite_score,
      rq.threshold_band,
      rq.blocking_rules,
      rq.field_diffs,
      rq.recommended_action,
      ${compareSelect}
    FROM ${formatEntityGraphTableName(entityId, '__review_queue', scenarioId)} rq
    LEFT JOIN ${formatEntityGraphTableName(entityId, '__standardized', scenarioId)} sa
      ON rq."record_a_id" = sa."record_id"
    LEFT JOIN ${formatEntityGraphTableName(entityId, '__standardized', scenarioId)} sb
      ON rq."record_b_id" = sb."record_id"
    LEFT JOIN latest_decisions ld
      ON rq."pair_id" = ld."pair_id" AND ld.rn = 1
    WHERE ${statusClause}
    ORDER BY rq."composite_score" DESC
    LIMIT ${safeLimit}
  `;

  const rows = await withEntityGraphWorkspaceQuery(scenarioId, (query) =>
    query<EntityGraphReviewPairSqlRow>(sql)
  );
  return rows.map((row) => ({
    pair_id: row.pair_id,
    record_a_id: row.record_a_id,
    record_b_id: row.record_b_id,
    source_a: row.source_a,
    source_b: row.source_b,
    composite_score: row.composite_score,
    threshold_band: row.threshold_band,
    recommended_action: row.recommended_action,
    compare_fields: buildEntityGraphCompareFields(entity, row),
    feature_contributions: buildEntityGraphFeatureContributions(entity, row),
  }));
}

function entitySingularReference(entityType: string): string {
  if (entityType === 'location') return 'store/location';
  if (entityType === 'customer') return 'person/customer';
  return entityType;
}

/**
 * Few-shot examples tailored to the entity. Hard-coded location-only
 * examples bias the model when the prompt is rendered for customer or
 * generic runs. Each block ends with three pairs: a clear merge, a clear
 * not_match, and a below-floor defer that uses the entity's identity
 * fields and the configured floor.
 */
function buildExamplesBlock(entityType: string, floor: number): string {
  // Round to two decimals; clamp to >= 0 so floor=0 doesn't produce -0.05.
  const belowFloor = Math.max(0, +(floor - 0.05).toFixed(2)).toFixed(2);
  if (entityType === 'customer') {
    return `Pair: full_name "John Doe" vs "Johnny Doe"; email "john.doe@example.com"
both sides; phone "555-0142" both; home_store "Example Retail Jacksonville" both.
→ \`merge\`, 0.94, "Same email, phone, and home store. 'Johnny' is a common
nickname for 'John' — name variation does not break a merge when identity
fields fully align."

Pair: full_name "Jane Doe" both sides; email
"jane.doe+demo@example.com" vs "jane.doe@example.com"; phone "212-555-0188"
vs "415-555-0144"; home_store differs.
→ \`merge\`, 0.91, "The emails resolve to the same mailbox via plus-aliasing,
which is a strong merge signal despite different phones and home stores."

Pair: full_name null vs "J. Doe"; email "jdoe@example.com" vs null;
phone null both; home_store "Example Retail Atlanta" vs null.
→ \`defer\`, ${belowFloor}, "Sparse fields with no overlapping identity
signal. Cannot evaluate without more data — below confidence floor, human
review required."`;
  }
  if (entityType === 'company') {
    return `Pair: name "Northwind Trading Co." vs "Northwind Trading Company";
website "northwind.example.com" both; phone "+1 415 555 0134" both; country
"US" both.
→ \`merge\`, 0.95, "Same website, phone, and country. The name only differs by
legal suffix abbreviation, so identity-bearing fields fully align."

Pair: name "Acme Logistics" both sides; website "logistics.example.com" vs
"logistics.example.org"; phone "+1 312 555 0180" vs "+44 20 7946 0958";
country "US" vs "GB".
→ \`not_match\`, 0.93, "Same display name but different websites, phones, and
countries. These signals point to separate companies sharing a common name."

Pair: name "Globex" vs "Globex LLC"; website null vs "globex.example";
phone null both; country null vs "US".
→ \`defer\`, ${belowFloor}, "Name overlap is not enough without corroborating
website, phone, or country. Below confidence floor, human review required."`;
  }
  // Default: location examples (also used for the generic singular).
  return `Pair: location_name "Example Retail Overland Park" vs "Example Retail Med Spa
Overland Park Galleria"; website "retail.example.com/ks/overland-park-galleria"
both sides; phone, city, state, region, ownership_model all match.
→ \`merge\`, 0.92, "Same website, phone, locale, and ownership. Name on B
includes the 'Med Spa' brand and 'Galleria' suffix; A is the short marketing
name. Identity-bearing fields fully align."

Pair: location_name "Example Retail Atlanta" both sides; website
"retail.example.com/ga/atlanta-collection" vs "retail.example.com/ga/atlanta-commons";
phone differs; city Atlanta both, ownership_model Corporate both.
→ \`not_match\`, 0.95, "Same brand and city but distinct websites pointing to
different store sub-paths (Collection vs Commons) and distinct phones — these
are two separate Atlanta locations."

Pair: location_name "Example Retail Med Spa Park Square" both sides; city,
state, region, ownership_model aligned; website present on A, null on B;
phone "(202) 555-0101" vs "(202) 555-0102".
→ \`defer\`, ${belowFloor}, "Locale and ownership match; name is a strong fuzzy
match. But contact info contradicts (different phones, missing website on B)
and the records disagree on which store a single physical address represents.
Below confidence floor — needs human resolution."`;
}

export function buildClaudeSystemPrompt(entityType: string, agentConfidenceFloor: number): string {
  const entitySingular = entitySingularReference(entityType);
  const floor = agentConfidenceFloor.toString();
  const examples = buildExamplesBlock(entityType, agentConfidenceFloor);
  return `You are an expert entity-resolution reviewer for ${entityType} master data.
For each pair of records, decide whether they describe the same real-world
${entitySingular} (e.g. the same physical store, the same person, the same
company). Your output drives downstream automation and is shown to human
reviewers — be thorough, calibrated, and decisive.

# How to reason

1. Identity-bearing fields are the strongest signals. Email, phone, primary
   address, unique URLs, government IDs. Two exact matches on these usually
   means \`merge\` regardless of name variations.

2. Allow for name variation. Real data has typos, abbreviations, nicknames
   (Bob ↔ Robert), formatting differences (Mr. vs Mister), missing diacritics,
   and ordering (last-first vs first-last). These do NOT break a merge if
   other identity fields align.

3. Geographic context (for locations). Same physical address + same brand =
   merge. Same brand + different cities = not_match. Same address + different
   brands = not_match (co-located businesses).

4. Cross-source duplicates are normal. The same entity often appears in CRM,
   web, ops, and marketing systems with field drift. Cross-source matches with
   consistent identity-bearing fields are typical \`merge\` cases.

5. Conflicting critical fields are red flags. Different DOBs, different
   government IDs, or contradictory primary identifiers usually mean
   \`not_match\` — unless one source clearly has a data-quality issue that
   another source corrects.

# Decision criteria

- \`merge\` — clear same-entity evidence (e.g. same email + name typo, same
  address + phone, same website + store name).
- \`not_match\` — clear different-entity evidence (e.g. different addresses +
  phones, conflicting IDs, same generic name in different cities).
- \`defer\` — records are too sparse to evaluate (mostly null fields), OR key
  fields contradict in a way that suggests data quality issues you cannot
  resolve. Use sparingly. If your honest confidence is below
  ${floor}, return \`defer\`.

# Confidence calibration

- If confidence is below ${floor}, return \`defer\` — you do not have enough
  evidence to commit either way.
- If confidence is at or above ${floor} but below the auto-apply bar (system
  default 0.85), return \`merge\` or \`not_match\`; the system keeps it in the
  agent/eval queue.
- Reserve high confidence (~0.85+) for clear same-entity or clear different-
  entity calls that should auto-apply without follow-up review.

Calibrate honestly. The system uses your confidence to gate auto-apply.
Inflated confidence wastes reviewer time; deflated confidence buries clear
matches.

# Inputs you'll see (per pair)

- \`pair_id\` — opaque identifier; pass through unchanged.
- \`source_a\`, \`source_b\` — source-system names (e.g. \`crm.customers\`).
- \`composite_score\`, \`threshold_band\` — feature-matcher output. ADVISORY.
- \`compare_fields\` — array of \`{ key, label, a, b, state }\`. The actual
  values are in \`a\` and \`b\`. The \`state\` enum (\`exact_match\`, \`different\`,
  \`record_a_missing\`, \`record_b_missing\`, \`both_missing\`) is a convenience
  signal pre-computed for you.
- \`feature_contributions\` — array of \`{ key, label, score, a, b }\` showing
  per-feature similarity scores.

The composite_score is a sanity check from a deterministic feature matcher,
NOT a substitute for your reasoning. Ground every decision in what the
values actually say.

# Output

Strict JSON, no prose around it:

\`\`\`json
{
  "assessments": [
    {
      "pair_id": "<unchanged>",
      "proposed_decision": "merge" | "not_match" | "defer",
      "proposed_confidence": 0.00,
      "assessment": "Cite specific fields and values. Under 60 words."
    }
  ]
}
\`\`\`

The \`assessment\` is shown to reviewers and evaluators — make it useful: name
the fields, name the values, name the inference. Avoid hedging like "possibly"
or "might" unless you genuinely mean it.

# Examples

${examples}

# Anti-patterns to avoid

- Back-solving a decision from \`composite_score\`. The score is a check, not
  your reasoning.
- Defaulting to \`defer\` when the data is workable. \`defer\` is for genuine
  evidentiary gaps, not for hedging mid-confidence calls.
- Treating typos or formatting differences as \`not_match\` when identity-
  bearing fields align.
- Confidence inflation (returning 0.99 for a moderate call) or deflation
  (returning 0.55 for a clear merge). Both poison the system's gating.`;
}

function readRedactionPresence(value: string | null): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function buildPromptCompareField(
  field: EntityGraphCompareFieldValue
): AgentReviewPromptCompareField {
  const left = readRedactionPresence(field.a);
  const right = readRedactionPresence(field.b);
  let state: RedactedAgentReviewFieldState = 'different';
  if (!left && !right) {
    state = 'both_missing';
  } else if (!left) {
    state = 'record_a_missing';
  } else if (!right) {
    state = 'record_b_missing';
  } else if (left === right) {
    state = 'exact_match';
  }

  return {
    key: field.key,
    label: field.label,
    a: left,
    b: right,
    state,
  };
}

function buildPromptFeatureContribution(
  feature: EntityGraphFeatureContribution
): AgentReviewPromptFeatureContribution {
  return {
    key: feature.key,
    label: feature.label,
    score: feature.score,
    a: readRedactionPresence(feature.a),
    b: readRedactionPresence(feature.b),
  };
}

export function buildAgentReviewPromptCandidates(
  candidates: AgentReviewCandidate[]
): AgentReviewPromptCandidate[] {
  return candidates.map((candidate) => ({
    pair_id: candidate.pair_id,
    source_a: candidate.source_a,
    source_b: candidate.source_b,
    composite_score: candidate.composite_score,
    threshold_band: candidate.threshold_band,
    recommended_action: candidate.recommended_action,
    compare_fields: candidate.compare_fields.map(buildPromptCompareField),
    feature_contributions: candidate.feature_contributions.map(buildPromptFeatureContribution),
  }));
}

/**
 * Scenarios whose workspaces ship in the repo as synthetic demo data. Only
 * these scenarios are allowed to forward raw `a` / `b` field values into the
 * Claude prompt — every other scenario falls back to the redacted shape so we
 * never accidentally send real customer PII to the LLM.
 *
 * If you add a new production scenario that touches real records, leave it
 * out of this set and add per-field redaction (see the follow-up tracked in
 * the original threshold-split plan).
 */
const RAW_VALUE_ALLOWED_SCENARIOS: ReadonlySet<EntityGraphScenarioId> =
  new Set<EntityGraphScenarioId>(['default']);

function redactPromptCandidates(
  candidates: AgentReviewPromptCandidate[]
): AgentReviewPromptCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    compare_fields: candidate.compare_fields.map((field) => ({
      ...field,
      a: field.a == null ? null : '[redacted]',
      b: field.b == null ? null : '[redacted]',
    })),
    feature_contributions: candidate.feature_contributions.map((feature) => ({
      ...feature,
      a: feature.a == null ? null : '[redacted]',
      b: feature.b == null ? null : '[redacted]',
    })),
  }));
}

export function buildClaudeUserPrompt(
  scenarioId: EntityGraphScenarioId,
  entityId: EntityGraphEntityId,
  candidates: AgentReviewCandidate[],
  agentConfidenceFloor: number
): string {
  const promptCandidates = buildAgentReviewPromptCandidates(candidates);
  // Only forward raw record values for scenarios whose workspaces ship in the
  // repo as synthetic demo data. Everywhere else we replace the values with a
  // redaction marker before they reach the LLM.
  const safePairs = RAW_VALUE_ALLOWED_SCENARIOS.has(scenarioId)
    ? promptCandidates
    : redactPromptCandidates(promptCandidates);
  return JSON.stringify({
    task: `Assess each unresolved review pair and return one non-final proposal per pair. Use 'defer' only when your confidence is below ${agentConfidenceFloor}. Keep assessment under 60 words.`,
    scenario: scenarioId,
    entity: entityId,
    pairs: safePairs,
  });
}

function buildDecisionBatchId(): string {
  return `claude-demo-${randomUUID()}`;
}

async function readAgentConfidenceFloorForEntity(
  scenarioId: EntityGraphScenarioId,
  entity: EntityGraphEntityDefinition
): Promise<number> {
  const { ResolutionSpecSchema } = await import('@bobsled-inc/model-spec/schemas');
  const file = specYamlPath(entity.defaultResolutionSpec, scenarioId);
  try {
    const content = await fs.readFile(file, 'utf8');
    const parsed = ResolutionSpecSchema.safeParse(YAML.parse(content));
    if (!parsed.success) {
      logServerError(
        'apps/explorer/lib/entity-graph-agent-sample-server:read-agent-confidence-floor',
        parsed.error,
        {
          scenario: scenarioId,
          entity: entity.id,
          file,
          fallback: 0.5,
        }
      );
      return 0.5;
    }
    // Schema fills agent_confidence_floor via .default(0.5) when agent_policy is set;
    // when the spec omits agent_policy entirely, fall back to the same default.
    return parsed.data.agent_policy?.agent_confidence_floor ?? 0.5;
  } catch (err) {
    // Surface the cause so a misconfigured spec or unreadable file is visible
    // in dev-server logs instead of silently falling back to 0.5 forever.
    logServerError(
      'apps/explorer/lib/entity-graph-agent-sample-server:read-agent-confidence-floor',
      err,
      {
        scenario: scenarioId,
        entity: entity.id,
        file,
        fallback: 0.5,
      }
    );
    return 0.5;
  }
}

async function persistAgentAssessments(
  scenarioId: EntityGraphScenarioId,
  entityId: EntityGraphEntityId,
  assessments: ClaudeAgentAssessment[],
  decisionBatchId: string
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-entity-graph-agent-review-'));
  const inputPath = path.join(tempDir, 'decisions.json');
  const runnerPath = getEntityGraphRunnerPath(scenarioId);

  try {
    await fs.writeFile(
      inputPath,
      JSON.stringify(buildAgentProposalDecisionRows(assessments, decisionBatchId), null, 2),
      'utf8'
    );
    const child = spawnEntityGraphCommand(
      [
        'review',
        'apply',
        '--input',
        inputPath,
        '--entity',
        entityId,
        '--runner',
        runnerPath,
        '--decision-source',
        CLAUDE_AGENT_DECISION_SOURCE,
        '--batch-id',
        decisionBatchId,
        '--json',
      ],
      scenarioId
    );
    const { stdout, stderr, code } = await collectOutput(child, { timeoutMs: 120_000 });
    if (code !== 0) {
      const stdoutText = stdout.trim();
      const stderrText = stderr.trim();
      logServerError(
        'apps/explorer/api/entity-graph-agent-review:apply',
        new Error(`Exit ${code}`),
        {
          code,
          stdout: stdoutText || undefined,
          stderr: stderrText || undefined,
          scenario: scenarioId,
          entity: entityId,
        }
      );
      throw new Error(
        [
          `Failed to persist agent review proposals (exit ${code}).`,
          `scenario=${scenarioId}`,
          `entity=${entityId}`,
          stdoutText ? `stdout=${stdoutText}` : null,
          stderrText ? `stderr=${stderrText}` : null,
        ]
          .filter(Boolean)
          .join(' ')
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runClaudeAgentReviewSample(
  options: RunClaudeAgentReviewSampleOptions
): Promise<AgentReviewSampleOutcome> {
  const { scenarioId, entityId, entity, limit } = options;
  const safeLimit = clampAgentSampleLimit(limit);
  const candidates = await loadAgentReviewCandidates(scenarioId, entityId, entity, safeLimit);
  if (candidates.length === 0) {
    return {
      result: buildAgentReviewSampleResult({
        entity: entityId,
        limit: safeLimit,
        candidateCount: 0,
        assessments: [],
      }),
      assessments: [],
    };
  }

  const agentConfidenceFloor = await readAgentConfidenceFloorForEntity(scenarioId, entity);

  const rawAssessments = await requestClaudeJson({
    systemPrompt: buildClaudeSystemPrompt(entityId, agentConfidenceFloor),
    userPrompt: buildClaudeUserPrompt(scenarioId, entityId, candidates, agentConfidenceFloor),
    timeoutMs: 120_000,
  });
  const allowedPairIds = new Set(candidates.map((candidate) => candidate.pair_id));
  const assessments = parseClaudeAgentAssessmentPayload(rawAssessments, { allowedPairIds });
  if (!assessments || assessments.length === 0) {
    throw new InvalidAgentAssessmentPayloadError();
  }

  const warnings =
    assessments.length < candidates.length
      ? [`Claude returned ${assessments.length} proposal(s) for ${candidates.length} pair(s).`]
      : [];
  const decisionBatchId = buildDecisionBatchId();
  await persistAgentAssessments(scenarioId, entityId, assessments, decisionBatchId);

  return {
    result: buildAgentReviewSampleResult({
      entity: entityId,
      limit: safeLimit,
      candidateCount: candidates.length,
      assessments,
      decisionBatchId,
      warnings,
    }),
    assessments,
  };
}
