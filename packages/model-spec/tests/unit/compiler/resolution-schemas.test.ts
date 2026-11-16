import { describe, expect, it } from 'vitest';

import { ResolutionSpecSchema } from '../../../src/compiler/schemas.js';

type ResolutionParseResult = ReturnType<typeof ResolutionSpecSchema.safeParse>;

function expectSemanticTriageIssue(
  result: ResolutionParseResult,
  path: Array<string | number>,
  message: string
): void {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['semantic_triage', ...path],
          message,
        }),
      ])
    );
  }
}

describe('ResolutionSpecSchema', () => {
  const baseResolution = {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: 'Resolve companies.',
    inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
    deterministic_rules: [
      {
        name: 'exact_company_name',
        conditions: [{ field: 'company_name', operator: 'exact', both_not_null: true }],
        action: 'auto_merge',
        confidence: 1,
      },
    ],
    thresholds: {
      auto_merge: 0.95,
      review: 0.6,
      auto_reject: 0.4,
    },
  } as const;

  it('accepts a deterministic rule with action flag_for_review', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      deterministic_rules: [
        ...baseResolution.deterministic_rules,
        {
          name: 'same_name_no_domain',
          conditions: [{ field: 'company_name', operator: 'exact', both_not_null: true }],
          action: 'flag_for_review',
          confidence: 0.85,
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deterministic_rules[1]?.action).toBe('flag_for_review');
    }
  });

  it('rejects non-terminal hash standardize transforms', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      standardize: [{ field: 'email', transforms: ['normalize_email', 'sha256', 'lowercase'] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('terminal'))).toBe(true);
    }
  });

  it('rejects fuzzy scoring on hashed fields', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      standardize: [{ field: 'email', transforms: ['normalize_email', 'hmac_sha256'] }],
      scoring: {
        method: 'weighted_features',
        features: [{ field: 'standardized_email', algorithm: 'jaro_winkler', weight: 1 }],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('exact scoring'))).toBe(
        true
      );
    }
  });

  it('requires explicit hashed profile exposure for hashed fields', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      standardize: [{ field: 'email', transforms: ['normalize_email', 'sha256'] }],
      profile: {
        attributes: [{ field: 'email', alias: 'email_hash' }],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('hashed: true'))).toBe(
        true
      );
    }
  });

  it('accepts pre_hashed fields in exact scoring and hashed profile attributes', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      standardize: [{ field: 'email_key', transforms: [], pre_hashed: true }],
      scoring: {
        method: 'weighted_features',
        features: [{ field: 'standardized_email_key', algorithm: 'exact', weight: 1 }],
      },
      profile: {
        attributes: [{ field: 'email_key', alias: 'email_key', hashed: true }],
        pii_controls: {
          attributes: [{ field: 'email_key', masking: 'hash', classification: 'email_match_key' }],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown keys in profile PII controls', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      standardize: [{ field: 'email_key', transforms: [], pre_hashed: true }],
      profile: {
        attributes: [{ field: 'email_key', alias: 'email_key', hashed: true }],
        pii_controls: {
          attributes: [{ field: 'email_key', maskin: 'hash' }],
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['profile', 'pii_controls', 'attributes', 0],
            message: expect.stringContaining('Unrecognized key'),
          }),
        ])
      );
    }
  });

  it('rejects an unknown deterministic rule action', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      deterministic_rules: [
        {
          name: 'bad_action',
          conditions: [{ field: 'company_name', operator: 'exact', both_not_null: true }],
          action: 'defer',
          confidence: 0.85,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('accepts auto_merge: null with only flag_for_review rules (review decisions merge)', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      deterministic_rules: [
        {
          name: 'same_name_no_domain',
          conditions: [{ field: 'company_name', operator: 'exact', both_not_null: true }],
          action: 'flag_for_review',
          confidence: 0.85,
        },
      ],
      thresholds: { auto_merge: null, review: 0.6, auto_reject: 0.4 },
    });

    expect(result.success).toBe(true);
  });

  it('accepts legacy include_mdm_metadata and normalizes it to include_entity_graph_metadata', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      profile: {
        views: {
          include_mdm_metadata: false,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile?.views?.include_entity_graph_metadata).toBe(false);
      expect('include_mdm_metadata' in (result.data.profile?.views ?? {})).toBe(false);
    }
  });

  it('prefers include_entity_graph_metadata over the legacy alias', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      profile: {
        views: {
          include_entity_graph_metadata: true,
          include_mdm_metadata: false,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile?.views?.include_entity_graph_metadata).toBe(true);
    }
  });

  it('defaults include_entity_graph_metadata to true when neither key is provided', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      profile: {
        views: {},
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile?.views?.include_entity_graph_metadata).toBe(true);
      expect('include_mdm_metadata' in (result.data.profile?.views ?? {})).toBe(false);
    }
  });

  it('accepts semantic triage and max embedding cost policy', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        max_embedding_cost_usd: 0.25,
      },
      semantic_triage: {
        provider: 'openai_text_embedding_3_small',
        fields: ['company_name', 'domain'],
        promote_to_merge_threshold: 0.94,
        promote_to_reject_threshold: 0.55,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_policy?.max_embedding_cost_usd).toBe(0.25);
      expect(result.data.semantic_triage?.fields).toEqual(['company_name', 'domain']);
    }
  });

  it('parses an agent_policy.panel block and applies defaults', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        panel: {
          enabled: true,
          first_panel: ['judge_a', 'judge_b', 'judge_c'],
          resolution_panel: ['judge_d', 'judge_e'],
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const panel = result.data.agent_policy?.panel;
      expect(panel?.enabled).toBe(true);
      // Defaults.
      expect(panel?.mode).toBe('replace');
      expect(panel?.consensus).toBe('unanimous');
      expect(panel?.on_unresolved).toBe('defer');
      expect(panel?.unanimous_confidence).toBe(0.95);
      expect(panel?.resolution_confidence).toBe(0.7);
    }
  });

  it('rejects an enabled panel with fewer than two first-panel judges', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        panel: {
          enabled: true,
          first_panel: ['only_one'],
          resolution_panel: ['judge_d'],
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'first_panel needs >= 2 judges for consensus to be meaningful',
          }),
        ])
      );
    }
  });

  it("rejects panel.mode 'escalate' when the single agent is disabled", () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: false,
        panel: {
          enabled: true,
          mode: 'escalate',
          first_panel: ['judge_a', 'judge_b'],
          resolution_panel: ['judge_d'],
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "panel.mode 'escalate' requires agent_policy.enabled = true",
          }),
        ])
      );
    }
  });

  it('leaves agent_policy.panel undefined when not provided', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: { enabled: true },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_policy?.panel).toBeUndefined();
    }
  });

  it('parses agent_policy.judge tier values and leaves it undefined when absent', () => {
    for (const judge of ['model', 'agent'] as const) {
      const result = ResolutionSpecSchema.safeParse({
        ...baseResolution,
        agent_policy: { enabled: true, judge },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agent_policy?.judge).toBe(judge);
      }
    }

    const absent = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: { enabled: true },
    });
    expect(absent.success).toBe(true);
    if (absent.success) {
      expect(absent.data.agent_policy?.judge).toBeUndefined();
    }
  });

  it('rejects an agent_policy.judge value outside the model/agent enum', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: { enabled: true, judge: 'human' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['agent_policy', 'judge'] })])
      );
    }
  });

  it('parses an agent_policy.reviewer http block round-trip', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: {
          kind: 'http',
          url: 'https://reviewer.example/review',
          auth_token: '${{ env.REVIEWER_TOKEN }}',
          timeout_s: 300,
          poll_interval_s: 5,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_policy?.reviewer).toEqual({
        kind: 'http',
        url: 'https://reviewer.example/review',
        auth_token: '${{ env.REVIEWER_TOKEN }}',
        timeout_s: 300,
        poll_interval_s: 5,
      });
    }
  });

  it('accepts a local reviewer argv array and rejects an empty array', () => {
    const spec = {
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'command', command: ['node', 'reviewer.mjs', 'argument with spaces'] },
      },
    };
    expect(ResolutionSpecSchema.safeParse(spec).success).toBe(true);
    expect(
      ResolutionSpecSchema.safeParse({
        ...spec,
        agent_policy: { ...spec.agent_policy, reviewer: { kind: 'command', command: [] } },
      }).success
    ).toBe(false);
  });

  it('parses an agent_policy.reviewer command block and accepts $VAR auth placeholders on http', () => {
    const command = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'command', command: 'claude -p --output-format json', timeout_s: 120 },
      },
    });
    expect(command.success).toBe(true);

    const dollarToken = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'http', url: 'https://r.example/review', auth_token: '$MY_TOKEN' },
      },
    });
    expect(dollarToken.success).toBe(true);
  });

  it('rejects a literal (non-placeholder) reviewer auth_token', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: {
          kind: 'http',
          url: 'https://reviewer.example/review',
          auth_token: 'sk-live-secret-value',
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('environment variable placeholder'),
          }),
        ])
      );
    }
  });

  it('rejects a plain-http reviewer url unless the host is loopback', () => {
    const remote = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'http', url: 'http://reviewer.example/review' },
      },
    });
    expect(remote.success).toBe(false);

    const loopback = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'http', url: 'http://127.0.0.1:8080/review' },
      },
    });
    expect(loopback.success).toBe(true);
  });

  it('rejects reviewer fields that do not belong to the declared kind (strict)', () => {
    const httpWithCommand = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'http', url: 'https://r.example/review', command: 'echo' },
      },
    });
    expect(httpWithCommand.success).toBe(false);

    const commandWithPoll = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: {
        enabled: true,
        reviewer: { kind: 'command', command: 'echo', poll_interval_s: 5 },
      },
    });
    expect(commandWithPoll.success).toBe(false);

    const missingUrl = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      agent_policy: { enabled: true, reviewer: { kind: 'http' } },
    });
    expect(missingUrl.success).toBe(false);
  });

  it('accepts semantic triage with a custom embedding model', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      semantic_triage: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
        price_per_million_tokens_usd: 0.13,
        fields: ['company_name'],
        promote_to_merge_threshold: 0.94,
        promote_to_reject_threshold: 0.55,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.semantic_triage?.model).toBe('text-embedding-3-large');
      expect(result.data.semantic_triage?.dimensions).toBe(3072);
    }
  });

  it('rejects semantic triage without fields', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      semantic_triage: {
        provider: 'openai_text_embedding_3_small',
        fields: [],
        promote_to_merge_threshold: 0.94,
        promote_to_reject_threshold: 0.55,
      },
    });

    expectSemanticTriageIssue(result, ['fields'], 'At least one semantic triage field is required');
  });

  it('rejects semantic triage duplicate fields', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      semantic_triage: {
        provider: 'openai_text_embedding_3_small',
        fields: ['company_name', 'company_name'],
        promote_to_merge_threshold: 0.94,
        promote_to_reject_threshold: 0.55,
      },
    });

    expectSemanticTriageIssue(
      result,
      ['fields'],
      'semantic_triage.fields must not contain duplicates'
    );
  });

  it('rejects semantic triage thresholds that overlap', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      semantic_triage: {
        provider: 'openai_text_embedding_3_small',
        fields: ['company_name'],
        promote_to_merge_threshold: 0.55,
        promote_to_reject_threshold: 0.55,
      },
    });

    expectSemanticTriageIssue(
      result,
      ['promote_to_reject_threshold'],
      'promote_to_reject_threshold must be < promote_to_merge_threshold'
    );
  });

  it('rejects semantic triage with inverted thresholds', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...baseResolution,
      semantic_triage: {
        provider: 'openai_text_embedding_3_small',
        fields: ['company_name'],
        promote_to_merge_threshold: 0.55,
        promote_to_reject_threshold: 0.94,
      },
    });

    expectSemanticTriageIssue(
      result,
      ['promote_to_reject_threshold'],
      'promote_to_reject_threshold must be < promote_to_merge_threshold'
    );
  });
});

describe('ResolutionSpecSchema thresholds', () => {
  const base = {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: 'Resolve companies.',
    inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
    deterministic_rules: [
      {
        name: 'exact_company_name',
        conditions: [{ field: 'company_name', operator: 'exact', both_not_null: true }],
        action: 'auto_merge',
        confidence: 1,
      },
    ],
  } as const;

  it('accepts auto_merge: null when deterministic rules exist', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      thresholds: { auto_merge: null, review: 0.6, auto_reject: 0.4 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thresholds.auto_merge).toBeNull();
    }
  });

  it('rejects auto_merge: null without deterministic rules — nothing could merge', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      deterministic_rules: [],
      scoring: {
        method: 'weighted_features',
        features: [{ field: 'company_name', algorithm: 'jaro_winkler', weight: 1 }],
      },
      thresholds: { auto_merge: null, review: 0.6, auto_reject: 0.4 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['thresholds', 'auto_merge'],
            message: expect.stringContaining('deterministic rule'),
          }),
        ])
      );
    }
  });

  it('skips the auto_merge > review ordering check when auto_merge is null', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      thresholds: { auto_merge: null, review: 0.9, auto_reject: 0.4 },
    });
    expect(result.success).toBe(true);
  });

  it('still rejects numeric auto_merge <= review', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      thresholds: { auto_merge: 0.5, review: 0.6, auto_reject: 0.4 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent_review that differs from review (regression: bundle-level validate)', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.4, agent_review: 0.7 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'agent_review must match review when both are set',
          }),
        ])
      );
    }
  });

  it('accepts agent_review equal to review and drops it from the parsed output', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.4, agent_review: 0.6 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('agent_review' in result.data.thresholds).toBe(false);
      expect(result.data.thresholds.review).toBe(0.6);
    }
  });
});

describe('ResolutionSpecSchema fellegi_sunter scoring', () => {
  const base = {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: 'Resolve companies.',
    inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
    deterministic_rules: [
      {
        name: 'exact_company_name',
        conditions: [{ field: 'company_name', operator: 'exact', both_not_null: true }],
        action: 'auto_merge',
        confidence: 1,
      },
    ],
    thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.4 },
  } as const;

  const fsScoring = {
    method: 'fellegi_sunter',
    prior: 0.0001,
    comparisons: [
      {
        field: 'standardized_company_name',
        levels: [
          { op: 'exact', m: 0.85, u: 0.0001 },
          { op: 'jaro_winkler', gte: 0.9, m: 0.1, u: 0.001 },
          { op: 'else', m: 0.05, u: 0.9989 },
        ],
      },
    ],
  };

  function expectIssueMessage(result: ResolutionParseResult, message: string): void {
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ message })])
      );
    }
  }

  it('accepts a valid fellegi_sunter scoring block', () => {
    const result = ResolutionSpecSchema.safeParse({ ...base, scoring: fsScoring });
    expect(result.success).toBe(true);
    if (result.success && result.data.scoring?.method === 'fellegi_sunter') {
      expect(result.data.scoring.prior).toBe(0.0001);
      expect(result.data.scoring.comparisons[0]?.levels).toHaveLength(3);
    }
  });

  it('still accepts the weighted_features method', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'weighted_features',
        features: [{ field: 'standardized_company_name', algorithm: 'exact', weight: 1 }],
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([0, 1, -0.1, 1.5])('rejects a prior outside (0, 1): %s', (prior) => {
    // prior feeds log2(prior / (1 - prior)); the 0 and 1 rails are the dangerous
    // ends (−Inf / division-by-zero), so pin both bounds, not just the upper one.
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: { ...fsScoring, prior },
    });
    expect(result.success).toBe(false);
  });

  it('requires the final level to be { op: else }', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', m: 0.85, u: 0.0001 },
              { op: 'jaro_winkler', gte: 0.9, m: 0.15, u: 0.9999 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(result, 'The final level of a comparison must be { op: else }');
  });

  it('rejects an { op: else } level that is not last', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', m: 0.85, u: 0.0001 },
              { op: 'else', m: 0.1, u: 0.5 },
              { op: 'jaro_winkler', gte: 0.9, m: 0.05, u: 0.4999 },
              { op: 'else', m: 0.05, u: 0.9989 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(result, 'Only the final level of a comparison may be { op: else }');
  });

  it('rejects the same field appearing in more than one comparison', () => {
    // Codegen sums one CASE per comparison, so a repeated field double-counts its
    // evidence and collides in the field_scores JSON (last key wins on parse).
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', m: 0.85, u: 0.0001 },
              { op: 'else', m: 0.15, u: 0.9999 },
            ],
          },
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', m: 0.7, u: 0.01 },
              { op: 'else', m: 0.3, u: 0.99 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(
      result,
      "Duplicate comparison field 'standardized_company_name': each field may appear in at most one fellegi_sunter comparison"
    );
  });

  it('requires a gte threshold for fuzzy ops', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'jaro_winkler', m: 0.1, u: 0.001 },
              { op: 'else', m: 0.9, u: 0.999 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(result, "Level op 'jaro_winkler' requires a 'gte' similarity threshold");
  });

  it('rejects a gte on a non-threshold op', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', gte: 0.9, m: 0.85, u: 0.0001 },
              { op: 'else', m: 0.15, u: 0.9999 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(result, "Level op 'exact' must not set 'gte'");
  });

  it('rejects empty comparisons', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: { method: 'fellegi_sunter', prior: 0.0001, comparisons: [] },
    });
    expectIssueMessage(result, 'At least one fellegi_sunter comparison is required');
  });

  it('rejects a comparison with only an else level', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          { field: 'standardized_company_name', levels: [{ op: 'else', m: 0.5, u: 0.5 }] },
        ],
      },
    });
    expectIssueMessage(
      result,
      'A fellegi_sunter comparison needs at least one level plus a final else level'
    );
  });

  it('rejects an unknown key on a level (strict)', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              // `threshold` is a typo for `gte` — strict mode must reject it.
              { op: 'jaro_winkler', threshold: 0.9, m: 0.1, u: 0.001 },
              { op: 'else', m: 0.9, u: 0.999 },
            ],
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a level with both m and u equal to 0', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'exact', m: 0, u: 0 },
              { op: 'else', m: 1, u: 1 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(result, 'A level must not set both m and u to 0');
  });

  it('rejects ascending gte thresholds for the same op', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'jaro_winkler', gte: 0.8, m: 0.3, u: 0.01 },
              { op: 'jaro_winkler', gte: 0.95, m: 0.1, u: 0.001 },
              { op: 'else', m: 0.6, u: 0.989 },
            ],
          },
        ],
      },
    });
    expectIssueMessage(
      result,
      "Levels with op 'jaro_winkler' must use strictly decreasing gte thresholds (most-strict first)"
    );
  });

  it('accepts decreasing gte thresholds for the same op', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'jaro_winkler', gte: 0.95, m: 0.1, u: 0.001 },
              { op: 'jaro_winkler', gte: 0.8, m: 0.3, u: 0.01 },
              { op: 'else', m: 0.6, u: 0.989 },
            ],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('allows ascending gte across different ops (per-op check only)', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...base,
      scoring: {
        method: 'fellegi_sunter',
        prior: 0.0001,
        comparisons: [
          {
            field: 'standardized_company_name',
            levels: [
              { op: 'edit_distance', gte: 0.7, m: 0.2, u: 0.02 },
              { op: 'jaro_winkler', gte: 0.9, m: 0.2, u: 0.01 },
              { op: 'else', m: 0.6, u: 0.97 },
            ],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});
