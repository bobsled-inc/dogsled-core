import { describe, expect, it } from 'vitest';

import YAML from 'yaml';

import {
  detectDecisionInputFormat,
  generateApplySql,
  parseCsvDecisions,
  parseJsonDecisions,
  parseYamlDecisions,
} from '../../../../src/compiler/identity/review-apply.js';
import {
  formatCsv,
  formatJson,
  formatYaml,
  generateExportQuery,
} from '../../../../src/compiler/identity/review-export.js';

import type { ReviewExportRow } from '../../../../src/compiler/identity/types.js';

// ---------------------------------------------------------------------------
// Review apply (CSV parsing)
// ---------------------------------------------------------------------------

describe('parseCsvDecisions', () => {
  it('parses valid CSV decisions', () => {
    const csv = [
      'pair_id,decision,reviewer,reason',
      'abc123,merge,john,Same company',
      'def456,not_match,jane,Different entities',
    ].join('\n');

    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.pair_id).toBe('abc123');
    expect(decisions[0]!.decision).toBe('merge');
    expect(decisions[1]!.decision).toBe('not_match');
    expect(warnings).toHaveLength(0);
  });

  it('handles defer decisions', () => {
    const csv = 'pair_id,decision\nabc,defer\n';
    const { decisions } = parseCsvDecisions(csv);
    expect(decisions[0]!.decision).toBe('defer');
  });

  it('rejects escalate decisions (no longer a valid value)', () => {
    const csv = 'pair_id,decision\nabc,escalate\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('invalid decision'))).toBe(true);
  });

  it('warns on invalid decision values', () => {
    const csv = 'pair_id,decision\nabc,invalid\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('invalid decision'))).toBe(true);
  });

  it('warns on empty pair_id', () => {
    const csv = 'pair_id,decision\n,merge\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('empty pair_id'))).toBe(true);
  });

  it('deduplicates pair_ids keeping last occurrence', () => {
    const csv = 'pair_id,decision\nabc,merge\nabc,not_match\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe('not_match');
    expect(warnings.some((w) => w.includes('Duplicate pair_id'))).toBe(true);
  });

  it('warns on missing required columns', () => {
    const csv = 'id,action\nabc,merge\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('Missing required column'))).toBe(true);
  });

  it('defaults reviewer to human', () => {
    const csv = 'pair_id,decision\nabc,merge\n';
    const { decisions } = parseCsvDecisions(csv);
    expect(decisions[0]!.reviewer).toBe('human');
  });

  it('parses confidence and proposal metadata from CSV', () => {
    const csv =
      'pair_id,decision,confidence,proposed_decision,proposed_confidence\nabc,defer,0.61,merge,0.74\n';
    const { decisions } = parseCsvDecisions(csv);
    expect(decisions[0]).toMatchObject({
      pair_id: 'abc',
      decision: 'defer',
      confidence: 0.61,
      proposed_decision: 'merge',
      proposed_confidence: 0.74,
    });
  });

  it('preserves status field through CSV round-trip', () => {
    const csv = 'pair_id,decision,status\npair-1,merge,proposed\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(warnings).toHaveLength(0);
    expect(decisions[0]!.status).toBe('proposed');
  });

  it('rejects invalid status values in CSV with a warning', () => {
    const csv = 'pair_id,decision,status\npair-1,merge,bogus\n';
    const { decisions, warnings } = parseCsvDecisions(csv);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('invalid status'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review apply (JSON parsing)
// ---------------------------------------------------------------------------

describe('parseJsonDecisions', () => {
  it('parses valid JSON decisions', () => {
    const json = JSON.stringify([
      { pair_id: 'abc', decision: 'merge', reviewer: 'john' },
      { pair_id: 'def', decision: 'not_match' },
    ]);

    const { decisions, warnings } = parseJsonDecisions(json);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.decision).toBe('merge');
    expect(warnings).toHaveLength(0);
  });

  it('rejects non-array JSON', () => {
    const { warnings } = parseJsonDecisions('{"pair_id": "abc"}');
    expect(warnings.some((w) => w.includes('must be an array'))).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const { warnings } = parseJsonDecisions('not json');
    expect(warnings.some((w) => w.includes('Invalid JSON'))).toBe(true);
  });

  it('parses entity_graph_decision_bundle.v1 payloads', () => {
    const bundle = JSON.stringify({
      version: 'entity_graph_decision_bundle.v1',
      entity: 'company',
      mode: 'propose',
      decision_source: 'agent',
      decisions: [
        {
          pair_id: 'abc123',
          decision: 'merge',
          reason: 'same domain and DUNS',
        },
      ],
    });

    const { bundle: parsedBundle, decisions, warnings } = parseJsonDecisions(bundle);
    expect(warnings).toHaveLength(0);
    expect(parsedBundle?.decision_source).toBe('agent');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      pair_id: 'abc123',
      decision: 'merge',
      reviewer: 'agent',
      decision_source: 'agent',
      reason: 'same domain and DUNS',
    });
  });

  it('parses confidence fields from JSON decisions', () => {
    const json = JSON.stringify([
      {
        pair_id: 'abc',
        decision: 'defer',
        confidence: 0.63,
        proposed_decision: 'merge',
        proposed_confidence: 0.81,
      },
    ]);

    const { decisions } = parseJsonDecisions(json);
    expect(decisions[0]).toMatchObject({
      pair_id: 'abc',
      confidence: 0.63,
      proposed_decision: 'merge',
      proposed_confidence: 0.81,
    });
  });

  // Regression for the demo-blocking P1 bug: explorer wrote
  // AgentProposalDecisionRow[] with status='proposed', and the parser silently
  // dropped the status field. The constructed ReviewDecisionRow had
  // status=undefined, generateApplySql's actionable filter let it through, and
  // resolveDecisionStatus(merge, undefined) returned 'applied'. Result: agent
  // proposals NEVER appeared as 'proposed' — they jumped straight to applied.
  it('preserves status="proposed" through the explorer → CLI round-trip', () => {
    const json = JSON.stringify([
      {
        pair_id: 'agent-prop-1',
        decision: 'merge',
        status: 'proposed',
        reviewer: 'claude-code-demo',
        reason: 'Same email domain and exact name match.',
        proposed_decision: 'merge',
        proposed_confidence: 0.74,
        decision_source: 'claude_code_demo',
        decision_batch_id: 'claude-demo-abc',
      },
    ]);

    const { decisions, warnings } = parseJsonDecisions(json);
    expect(warnings).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe('proposed');
    expect(decisions[0]!.decision).toBe('merge');
  });

  it('preserves status="deferred" alongside decision="defer"', () => {
    const json = JSON.stringify([
      {
        pair_id: 'agent-defer-1',
        decision: 'defer',
        status: 'deferred',
        reviewer: 'claude-code-demo',
        reason: 'Confidence below floor',
      },
    ]);

    const { decisions, warnings } = parseJsonDecisions(json);
    expect(warnings).toHaveLength(0);
    expect(decisions[0]!.status).toBe('deferred');
  });

  it('rejects an invalid status value with a warning instead of silently dropping it', () => {
    const json = JSON.stringify([
      { pair_id: 'pair-bad', decision: 'merge', status: 'totally-bogus' },
    ]);

    const { decisions, warnings } = parseJsonDecisions(json);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('invalid status'))).toBe(true);
  });

  it('accepts the legacy "escalated" status for backward compat', () => {
    const json = JSON.stringify([
      { pair_id: 'pair-legacy', decision: 'merge', status: 'escalated' },
    ]);

    const { decisions, warnings } = parseJsonDecisions(json);
    expect(warnings).toHaveLength(0);
    expect(decisions[0]!.status).toBe('escalated');
  });

  it('preserves status when payload is an entity_graph_decision_bundle.v1 envelope', () => {
    const bundle = JSON.stringify({
      version: 'entity_graph_decision_bundle.v1',
      entity: 'company',
      mode: 'propose',
      decision_source: 'agent',
      decisions: [
        { pair_id: 'pair-1', decision: 'merge', status: 'proposed' },
        { pair_id: 'pair-2', decision: 'defer', status: 'deferred' },
      ],
    });

    const { decisions, warnings } = parseJsonDecisions(bundle);
    expect(warnings).toHaveLength(0);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.status).toBe('proposed');
    expect(decisions[1]!.status).toBe('deferred');
  });
});

// ---------------------------------------------------------------------------
// Review apply (YAML parsing)
// ---------------------------------------------------------------------------

describe('parseYamlDecisions', () => {
  it('parses valid YAML decisions', () => {
    const yaml = YAML.stringify([
      { pair_id: 'abc', decision: 'merge', reviewer: 'john' },
      { pair_id: 'def', decision: 'not_match' },
    ]);

    const { decisions, warnings } = parseYamlDecisions(yaml);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.decision).toBe('merge');
    expect(decisions[1]!.decision).toBe('not_match');
    expect(warnings).toHaveLength(0);
  });

  it('rejects non-array YAML', () => {
    const { warnings } = parseYamlDecisions('pair_id: abc\ndecision: merge\n');
    expect(warnings.some((w) => w.includes('must be a list'))).toBe(true);
  });

  it('rejects invalid YAML', () => {
    const { warnings } = parseYamlDecisions('{{invalid');
    expect(warnings.some((w) => w.includes('Invalid YAML'))).toBe(true);
  });

  it('parses entity_graph_decision_bundle.v1 YAML payloads', () => {
    const yaml = YAML.stringify({
      version: 'entity_graph_decision_bundle.v1',
      entity: 'company',
      mode: 'propose',
      decision_source: 'agent',
      decisions: [{ pair_id: 'abc123', decision: 'merge', reason: 'same domain and DUNS' }],
    });

    const { bundle: parsedBundle, decisions, warnings } = parseYamlDecisions(yaml);
    expect(warnings).toHaveLength(0);
    expect(parsedBundle?.decision_source).toBe('agent');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      pair_id: 'abc123',
      decision: 'merge',
      reviewer: 'agent',
      reason: 'same domain and DUNS',
    });
  });

  it('preserves status field through YAML round-trip', () => {
    const yaml = YAML.stringify([{ pair_id: 'pair-1', decision: 'merge', status: 'proposed' }]);

    const { decisions, warnings } = parseYamlDecisions(yaml);
    expect(warnings).toHaveLength(0);
    expect(decisions[0]!.status).toBe('proposed');
  });

  it('rejects invalid status in YAML with a warning', () => {
    const yaml = YAML.stringify([{ pair_id: 'pair-1', decision: 'merge', status: 'unknown' }]);

    const { decisions, warnings } = parseYamlDecisions(yaml);
    expect(decisions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('invalid status'))).toBe(true);
  });
});

describe('detectDecisionInputFormat', () => {
  it('detects csv input', () => {
    expect(detectDecisionInputFormat('pair_id,decision\nabc,merge\n')).toBe('csv');
  });

  it('detects raw json arrays', () => {
    expect(detectDecisionInputFormat('[{"pair_id":"abc","decision":"merge"}]')).toBe('json');
  });

  it('detects entity graph decision bundles', () => {
    expect(
      detectDecisionInputFormat(
        '{"version":"entity_graph_decision_bundle.v1","entity":"company","mode":"propose","decision_source":"agent","decisions":[]}'
      )
    ).toBe('decision_bundle');
  });

  it('detects yaml list input', () => {
    expect(detectDecisionInputFormat('- pair_id: abc\n  decision: merge\n')).toBe('yaml');
  });

  it('detects yaml decision bundle input', () => {
    expect(
      detectDecisionInputFormat('version: entity_graph_decision_bundle.v1\nentity: company\n')
    ).toBe('yaml');
  });
});

// ---------------------------------------------------------------------------
// Review export formatting
// ---------------------------------------------------------------------------

describe('formatCsv', () => {
  it('formats rows as CSV with header', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '["exact_domain"]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const csv = formatCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'pair_id,record_a_id,record_b_id,source_a,source_b,composite_score,threshold_band,blocking_rules,field_diffs,recommended_action,semantic_score,semantic_decision,rule_name'
    );
    expect(lines[1]).toContain('abc');
    expect(lines[1]).toContain('0.85');
  });

  it('escapes fields with commas', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm,inc',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '[]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const csv = formatCsv(rows);
    expect(csv).toContain('"crm,inc"');
  });

  it('escapes double quotes per RFC 4180', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm "Gold"',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '[]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const csv = formatCsv(rows);
    expect(csv).toContain('"crm ""Gold"""');
  });
});

describe('formatJson', () => {
  it('formats rows as JSON array', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '[]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const json = formatJson(rows);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pair_id).toBe('abc');
  });

  it('adds explicit editable fields for template JSON exports', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '[]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const json = formatJson(rows, { template: true });
    const parsed = JSON.parse(json);
    expect(parsed[0].decision).toBeNull();
    expect(parsed[0].reviewer).toBeNull();
    expect(parsed[0].reason).toBeNull();
    expect(parsed[0].proposed_decision).toBeNull();
    expect(parsed[0].proposed_confidence).toBeNull();
  });
});

describe('formatYaml', () => {
  it('formats rows as YAML list', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '[]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const yaml = formatYaml(rows);
    const parsed = YAML.parse(yaml) as ReviewExportRow[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.pair_id).toBe('abc');
    expect(yaml).toContain('pair_id: abc');
  });

  it('adds explicit editable fields for template YAML exports', () => {
    const rows: ReviewExportRow[] = [
      {
        pair_id: 'abc',
        record_a_id: 'r1',
        record_b_id: 'r2',
        source_a: 'crm',
        source_b: 'zi',
        composite_score: 0.85,
        threshold_band: 'review',
        blocking_rules: '[]',
        field_diffs: '{}',
        recommended_action: 'merge',
      },
    ];

    const yaml = formatYaml(rows, { template: true });
    const parsed = YAML.parse(yaml) as ReviewExportRow[];
    expect(parsed[0]!.decision).toBeNull();
    expect(parsed[0]!.reviewer).toBeNull();
    expect(parsed[0]!.reason).toBeNull();
    expect(parsed[0]!.proposed_decision).toBeNull();
    expect(parsed[0]!.proposed_confidence).toBeNull();
  });
});

describe('generateExportQuery', () => {
  it('applies threshold band filters and limit when requested', () => {
    const sql = generateExportQuery('company', 'entity_graph', 0.65, 'snowflake', {
      pendingOnly: true,
      thresholdBands: ['review'],
      limit: 25,
    });

    expect(sql).toContain(`"THRESHOLD_BAND" IN ('review')`);
    expect(sql).toContain('LIMIT 25');
    expect(sql).toContain(
      `(ld."PAIR_ID" IS NULL OR COALESCE(ld."STATUS", 'applied') IN ('proposed', 'deferred', 'escalated') OR (ld."STATUS" IS NULL AND ld."DECISION" IN ('defer', 'escalate')))`
    );
  });

  it('uses configured per-band thresholds when computing confidence gaps', () => {
    const sql = generateExportQuery('company', 'entity_graph', 0.65, 'snowflake', {
      pendingOnly: false,
      includeDecisionColumns: true,
      confidenceThresholds: {
        default: 0.75,
        byBand: {
          review: 0.68,
        },
      },
    });

    expect(sql).toContain(`WHEN rq."THRESHOLD_BAND" = 'review' THEN 0.68`);
    expect(sql).not.toContain(`WHEN rq."THRESHOLD_BAND" = 'agent_review'`);
    expect(sql).not.toContain(`WHEN rq."THRESHOLD_BAND" = 'human_review'`);
  });
});

describe('generateApplySql', () => {
  it('routes proposed-status decisions into apply_review_decisions_pending', () => {
    const statements = generateApplySql(
      [
        {
          pair_id: 'pair-1',
          decision: 'merge',
          status: 'proposed',
          reviewer: 'agent',
          confidence: 0.62,
          proposed_decision: 'merge',
          proposed_confidence: 0.62,
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      {
        defaultBatchId: 'batch-1',
        defaultDecisionSource: 'agent',
      }
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.name).toBe('apply_review_decisions_pending');
    expect(statements[0]!.sql).toContain("'proposed'");
    expect(statements[0]!.sql).toContain("'pair-1'");
  });
});
