import { z } from 'zod';

import { parseEnvPlaceholder } from '@bobsled-inc/protocol';

import { DEFAULT_TRUST_TIER_THRESHOLDS, DEFAULT_TRUST_WEIGHTS } from './profile-defaults.js';
import { SemanticTriageSchema } from './resolution-schemas.js';
import { identifierMsg, identifierRegex } from './shared-validators.js';
import { TrustTierSchema, dangerousExprMsg, dangerousExprRegex } from './schemas-shared.js';

// ---------------------------------------------------------------------------
// Profile sub-schemas (used only by ResolutionSpecSchema)
// ---------------------------------------------------------------------------

const HASH_STANDARDIZE_TRANSFORMS = new Set(['sha256', 'hmac_sha256']);

const ProfileDisplayNameSchema = z.strictObject({
  field: z.string().min(1).regex(identifierRegex, identifierMsg),
  source_precedence: z.array(z.string().min(1)).optional(),
});

const ProfileAttributeSchema = z.strictObject({
  field: z.string().min(1).regex(identifierRegex, identifierMsg),
  alias: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
  hashed: z.boolean().optional(),
});

const ProfilePiiControlsSchema = z.strictObject({
  attributes: z
    .array(
      z.strictObject({
        field: z.string().min(1).regex(identifierRegex, identifierMsg),
        masking: z.enum(['none', 'hash', 'partial', 'null']).default('none'),
        classification: z.string().min(1).optional(),
      })
    )
    .default([]),
});

const ProfileFreshnessWindowSchema = z.object({
  days: z.number().int().positive(),
  score: z.number().min(0).max(1),
});

const ProfileTrustWeightsSchema = z
  .object({
    identity: z.number().min(0).max(1).optional(),
    freshness: z.number().min(0).max(1).optional(),
    diversity: z.number().min(0).max(1).optional(),
    coverage: z.number().min(0).max(1).optional(),
  })
  .superRefine((data, ctx) => {
    const sum =
      (data.identity ?? DEFAULT_TRUST_WEIGHTS.identity) +
      (data.freshness ?? DEFAULT_TRUST_WEIGHTS.freshness) +
      (data.diversity ?? DEFAULT_TRUST_WEIGHTS.diversity) +
      (data.coverage ?? DEFAULT_TRUST_WEIGHTS.coverage);
    // Allow a tiny floating-point tolerance so legitimate inputs like
    // 0.4 + 0.25 + 0.2 + 0.15 aren't rejected by IEEE-754 drift.
    const FP_TOLERANCE = 1e-9;
    if (sum > 1 + FP_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `trust_weights must sum to <= 1.0 (got ${sum.toFixed(6)})`,
      });
    }
  });

const ProfileTrustTierThresholdsSchema = z
  .object({
    trusted: z.number().min(0).max(1).optional(),
    monitor: z.number().min(0).max(1).optional(),
    review: z.number().min(0).max(1).optional(),
  })
  .superRefine((data, ctx) => {
    const trusted = data.trusted ?? DEFAULT_TRUST_TIER_THRESHOLDS.trusted;
    const monitor = data.monitor ?? DEFAULT_TRUST_TIER_THRESHOLDS.monitor;
    const review = data.review ?? DEFAULT_TRUST_TIER_THRESHOLDS.review;
    if (trusted < monitor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trusted'],
        message: 'trusted must be >= monitor',
      });
    }
    if (monitor < review) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['monitor'],
        message: 'monitor must be >= review',
      });
    }
  });

const ProfileQualitySchema = z.object({
  freshness_windows: z.array(ProfileFreshnessWindowSchema).min(1).optional(),
  source_diversity_cap: z.number().positive().optional(),
  trust_weights: ProfileTrustWeightsSchema.optional(),
  trust_tier_thresholds: ProfileTrustTierThresholdsSchema.optional(),
});

const ActivationProjectionFieldSchema = z.object({
  field: z.string().min(1).regex(identifierRegex, identifierMsg),
  target: z.string().min(1).regex(identifierRegex, identifierMsg),
});

const ActivationProjectionSchema = z.object({
  name: z.string().min(1).regex(identifierRegex, identifierMsg),
  version: z.string().min(1).regex(identifierRegex, identifierMsg),
  trust_gate: z.number().min(0).max(1),
  fields: z.array(ActivationProjectionFieldSchema).min(1),
  identity_map: z
    .object({
      source_system: z.string().min(1),
      id_alias: z.string().min(1).regex(identifierRegex, identifierMsg),
    })
    .optional(),
});

const ProfileViewsSchema = z
  .object({
    enabled: z.boolean().default(true),
    name_pattern: z.string().min(1).default('{source_table}_clean'),
    include_entity_graph_metadata: z.boolean().optional(),
    include_mdm_metadata: z.boolean().optional(),
  })
  .transform(({ include_entity_graph_metadata, include_mdm_metadata, ...rest }) => ({
    ...rest,
    include_entity_graph_metadata: include_entity_graph_metadata ?? include_mdm_metadata ?? true,
  }));

const EntitySemanticsSchema = z
  .object({
    definition: z.string().min(1).optional(),
    categories: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
          })
          .strict()
      )
      .optional(),
    positive_examples: z.array(z.string().min(1)).optional(),
    negative_examples: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Loopback hosts exempt from the reviewer-URL HTTPS requirement. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Env-var placeholder (`$MY_TOKEN` / `${{ env.MY_TOKEN }}`) — the same
 * convention as `EnvPlaceholderSchema` in `@bobsled-inc/connections`, built on
 * `@bobsled-inc/protocol`'s parser instead of importing `connections`: pulling
 * `connections` into compiler schemas drags its warehouse-driver runtime
 * (native modules) into browser/webpack bundles like the Explorer's.
 */
const EnvPlaceholderSchema = z.string().refine((value) => parseEnvPlaceholder(value) !== null, {
  message: 'Must be an environment variable placeholder like $MY_TOKEN or ${{ env.MY_TOKEN }}',
});

/**
 * `agent_policy.reviewer` — external reviewer transport for the agent review
 * phase (external reviewer contract: `entity_graph_review_request.v1`). `http` POSTs
 * the review request to a hosted agent; `command` pipes it to a local process
 * on stdin. `auth_token` must be an env placeholder (`$VAR` / `${{ env.VAR }}`)
 * resolved by the project's secret resolver at runtime — never a literal.
 */
const AgentReviewerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('http'),
      url: z
        .string()
        .url()
        .superRefine((url, ctx) => {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return; // .url() already rejected it; don't double-report.
          }
          const isLoopbackHttp =
            parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname);
          if (parsed.protocol !== 'https:' && !isLoopbackHttp) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'reviewer.url must use https (a bearer token travels with every request); plain http is allowed only for loopback hosts',
            });
          }
        }),
      auth_token: EnvPlaceholderSchema.optional(),
      timeout_s: z.number().positive().optional(),
      poll_interval_s: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('command'),
      command: z.union([z.string().min(1), z.array(z.string()).min(1)]),
      timeout_s: z.number().positive().optional(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Resolution spec (`type: resolution`)
// ---------------------------------------------------------------------------

export const ResolutionSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    name: z.string().min(1).regex(identifierRegex, identifierMsg),
    type: z.literal('resolution'),
    description: z.string().min(1),

    inputs: z
      .array(
        z.object({
          ref: z.string().min(1),
          role: z.enum(['internal', 'provider']).optional(),
          trust_tier: TrustTierSchema.optional(),
          id_fields: z
            .array(z.string().regex(identifierRegex, identifierMsg))
            .min(1, 'At least one id_field is required'),
        })
      )
      .min(1),

    standardize: z
      .array(
        z.object({
          field: z.string().regex(identifierRegex, identifierMsg),
          transforms: z.array(
            z.enum([
              'lowercase',
              'uppercase',
              'trim',
              'collapse_whitespace',
              'nullif_empty',
              'normalize_email',
              'normalize_email_uid2',
              'extract_email_domain',
              'strip_email_subaddress',
              'strip_accents',
              'strip_legal_suffixes',
              'strip_trading_as',
              'normalize_company',
              'strip_www',
              'strip_protocol',
              'extract_domain',
              'digits_only',
              'strip_country_code',
              'strip_phone_extension',
              'normalize_phone',
              'normalize_state',
              'expand_street_abbreviations',
              'normalize_street',
              'normalize_postal',
              'remove_punctuation',
              'fingerprint',
              'parse_number',
              'sha256',
              'hmac_sha256',
            ])
          ),
          pre_hashed: z.boolean().optional(),
        })
      )
      .optional()
      .default([]),

    blocking: z
      .object({
        rules: z
          .array(
            z.object({
              name: z.string().regex(identifierRegex, identifierMsg),
              key: z
                .string()
                .min(1)
                .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
            })
          )
          .default([]),
        candidate_limit: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),

    deterministic_rules: z
      .array(
        z.object({
          name: z.string().regex(identifierRegex, identifierMsg),
          conditions: z
            .array(
              z.object({
                field: z.string().regex(identifierRegex, identifierMsg),
                operator: z.enum(['exact']),
                both_not_null: z.boolean().optional().default(true),
              })
            )
            .min(1),
          // auto_merge: the pair merges directly when the rule fires.
          // flag_for_review: the pair routes to __review_queue regardless of
          // score band — the cautious default for strong-but-not-certain
          // signals (same name / different domain, same phone / different
          // address, ...). Adjudication happens through the existing review
          // flow; an applied merge decision folds in on the next cluster run.
          action: z.enum(['auto_merge', 'flag_for_review']),
          confidence: z.number().min(0).max(1),
        })
      )
      .optional()
      .default([]),

    scoring: z
      .discriminatedUnion('method', [
        z.object({
          method: z.literal('weighted_features'),
          features: z
            .array(
              z.object({
                field: z.string().min(1).regex(identifierRegex, identifierMsg),
                algorithm: z.enum([
                  'exact',
                  'jaro_winkler',
                  'edit_distance',
                  'soundex',
                  'numeric_distance',
                  'date_proximity',
                  'token_cosine',
                ]),
                weight: z.number().min(0).max(1),
              })
            )
            .min(1, 'At least one scoring feature is required'),
        }),
        z.object({
          // Probabilistic record linkage (Fellegi–Sunter). m/u can be learned
          // from labeled truthsets with `dogsled entity-graph truthset train`;
          // unsupervised EM training remains a follow-up.
          method: z.literal('fellegi_sunter'),
          // Prior probability that two random records are a match (λ).
          prior: z.number().gt(0).lt(1),
          comparisons: z
            .array(
              z
                .object({
                  field: z.string().min(1).regex(identifierRegex, identifierMsg),
                  levels: z
                    .array(
                      z
                        .object({
                          op: z.enum([
                            'exact',
                            'jaro_winkler',
                            'edit_distance',
                            'soundex',
                            'numeric_distance',
                            'date_proximity',
                            'token_cosine',
                            'else',
                          ]),
                          // Similarity threshold for fuzzy ops; omitted for
                          // exact / soundex / else.
                          gte: z.number().min(0).max(1).optional(),
                          // P(level | records match) and P(level | not a match).
                          m: z.number().min(0).max(1),
                          u: z.number().min(0).max(1),
                        })
                        .strict()
                    )
                    .min(
                      2,
                      'A fellegi_sunter comparison needs at least one level plus a final else level'
                    ),
                })
                .strict()
            )
            .min(1, 'At least one fellegi_sunter comparison is required'),
        }),
      ])
      .superRefine((scoring, ctx) => {
        if (scoring.method !== 'fellegi_sunter') return;
        const thresholdOps = new Set([
          'jaro_winkler',
          'edit_distance',
          'numeric_distance',
          'date_proximity',
          'token_cosine',
        ]);
        // A field may appear in at most one comparison. Codegen emits one CASE
        // per comparison and sums their bits, so a repeated field double-counts
        // its evidence and produces a field_scores JSON object with a duplicate
        // key (last value wins on parse — the first comparison's signal is lost).
        const seenFields = new Set<string>();
        scoring.comparisons.forEach((comparison, ci) => {
          if (seenFields.has(comparison.field)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['comparisons', ci, 'field'],
              message: `Duplicate comparison field '${comparison.field}': each field may appear in at most one fellegi_sunter comparison`,
            });
          }
          seenFields.add(comparison.field);
          const lastIndex = comparison.levels.length - 1;
          // Levels are first-match-wins in codegen, so same-op thresholds must be
          // authored most-strict-first; track the last gte seen per op to reject
          // an ascending order that would make a stricter level unreachable.
          const lastGteByOp = new Map<string, number>();
          comparison.levels.forEach((level, li) => {
            const isLast = li === lastIndex;
            if (level.op === 'else' && !isLast) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['comparisons', ci, 'levels', li, 'op'],
                message: 'Only the final level of a comparison may be { op: else }',
              });
            }
            if (level.op !== 'else' && isLast) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['comparisons', ci, 'levels', li, 'op'],
                message: 'The final level of a comparison must be { op: else }',
              });
            }
            if (thresholdOps.has(level.op) && level.gte === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['comparisons', ci, 'levels', li, 'gte'],
                message: `Level op '${level.op}' requires a 'gte' similarity threshold`,
              });
            }
            if (!thresholdOps.has(level.op) && level.gte !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['comparisons', ci, 'levels', li, 'gte'],
                message: `Level op '${level.op}' must not set 'gte'`,
              });
            }
            if (level.gte !== undefined) {
              const previousGte = lastGteByOp.get(level.op);
              if (previousGte !== undefined && level.gte >= previousGte) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['comparisons', ci, 'levels', li, 'gte'],
                  message: `Levels with op '${level.op}' must use strictly decreasing gte thresholds (most-strict first)`,
                });
              }
              lastGteByOp.set(level.op, level.gte);
            }
            if (level.m === 0 && level.u === 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['comparisons', ci, 'levels', li, 'm'],
                message: 'A level must not set both m and u to 0',
              });
            }
          });
        });
      })
      .optional(),

    thresholds: z
      .object({
        // `auto_merge: null` disables score-driven auto-merge entirely:
        // only deterministic_rules produce merge edges; every scored pair at
        // or above `review` routes to the review queue.
        auto_merge: z.number().min(0).max(1).nullable().optional(),
        review: z.number().min(0).max(1).optional(),
        auto_reject: z.number().min(0).max(1).optional(),
        agent_review: z.number().min(0).max(1).optional(),
      })
      .superRefine((thresholds, ctx) => {
        if (
          thresholds.review !== undefined &&
          thresholds.agent_review !== undefined &&
          thresholds.review !== thresholds.agent_review
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agent_review'],
            message: 'agent_review must match review when both are set',
          });
        }
      })
      .transform((thresholds) => ({
        auto_merge: thresholds.auto_merge,
        review: thresholds.review ?? thresholds.agent_review,
        auto_reject: thresholds.auto_reject,
      }))
      .pipe(
        z.object({
          auto_merge: z.number().min(0).max(1).nullable(),
          review: z.number().min(0).max(1),
          auto_reject: z.number().min(0).max(1),
        })
      ),

    agent_policy: z
      .object({
        enabled: z.boolean(),
        // User-facing judge tier for the review phase (external reviewer contract).
        //   absent  ⇒ model (default): the in-Dogsled model judge / panel serves
        //             the phase — an external reviewer (reviewerOverride or the
        //             spec's `reviewer:`) still wins when present, exactly as
        //             before this field existed. Backward-compatible.
        //   'model' ⇒ pin the model judge: `reviewerOverride` AND `reviewer:`
        //             are ignored (a host cannot upgrade a pinned-model entity;
        //             an ignored override is warned about). A host-injected
        //             `llmClient` still wins — it's the programmatic escape hatch.
        //   'agent' ⇒ require an external/tool-using reviewer transport
        //             (reviewerOverride > `reviewer:`). With neither available
        //             the phase skips (`no_judge_configured` + a warning naming
        //             the missing piece); it never falls back to the model judge.
        judge: z.enum(['model', 'agent']).optional(),
        // External reviewer transport (external reviewer contract). Absent ⇒ the
        // in-Dogsled model judge (`model:`) / panel behavior is unchanged.
        reviewer: AgentReviewerSchema.optional(),
        instructions_path: z.string().min(1).optional(),
        approval_policy: z.enum(['always', 'never', 'on_failure']).optional(),
        max_pairs_per_run: z.number().int().positive().optional(),
        max_cost_usd: z.number().positive().optional(),
        max_embedding_cost_usd: z.number().positive().optional(),
        batch_size: z.number().int().positive().optional(),
        token_budget_per_pair: z.number().int().positive().optional(),
        context_fields: z.array(z.string()).optional(),
        confirm_before_write: z.boolean().optional(),
        model: z.string().min(1).optional(),
        prompt_template: z.string().min(1).optional(),
        auto_apply_threshold: z.number().min(0).max(1).optional(),
        agent_confidence_floor: z.number().min(0).max(1).default(0.5),
        // Multi-model consensus reviewer for the review band. Absent ⇒ the
        // existing single-agent / human review behavior is unchanged.
        panel: z
          .object({
            enabled: z.boolean().default(false),
            mode: z.enum(['replace', 'escalate']).default('replace'),
            // Model role names resolved against platform.models at run time.
            first_panel: z.array(z.string().min(1)).min(1),
            resolution_panel: z.array(z.string().min(1)).min(1),
            consensus: z.enum(['unanimous', 'majority']).default('unanimous'),
            on_unresolved: z.enum(['defer']).default('defer'),
            unanimous_confidence: z.number().min(0).max(1).default(0.95),
            resolution_confidence: z.number().min(0).max(1).default(0.7),
          })
          .optional()
          .superRefine((panel, ctx) => {
            if (!panel?.enabled) return;
            if (panel.first_panel.length < 2) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['first_panel'],
                message: 'first_panel needs >= 2 judges for consensus to be meaningful',
              });
            }
          }),
      })
      .optional(),

    entity_id_policy: z
      .object({
        strategy: z.enum(['stable']).optional(),
        new_id: z.enum(['component_id']).optional(),
        merge: z.enum(['oldest_entity_id']).optional(),
        split: z.enum(['preserve_anchor']).optional(),
      })
      .optional(),

    pair_count_warn_limit: z.number().int().positive().optional(),

    semantic_triage: SemanticTriageSchema.optional(),

    entity_semantics: EntitySemanticsSchema.optional(),

    profile: z
      .object({
        display_name: ProfileDisplayNameSchema.optional(),
        attributes: z.array(ProfileAttributeSchema).optional(),
        pii_controls: ProfilePiiControlsSchema.optional(),
        quality: ProfileQualitySchema.optional(),
        activations: z.array(ActivationProjectionSchema).optional(),
        views: ProfileViewsSchema.optional(),
      })
      .optional(),

    outputs: z
      .object({
        target_schema: z.string().regex(identifierRegex, identifierMsg).optional(),
      })
      .optional(),
  })
  .superRefine((spec, ctx) => {
    const hashedFields = new Set<string>();
    const hashedFieldAliases = new Set<string>();
    const noteHashedField = (field: string) => {
      hashedFields.add(field);
      hashedFieldAliases.add(field);
      hashedFieldAliases.add(`standardized_${field}`);
    };
    const isHashedField = (field: string) => hashedFieldAliases.has(field);

    spec.standardize.forEach((entry, index) => {
      if (entry.pre_hashed) {
        noteHashedField(entry.field);
      }
      const firstHashIndex = entry.transforms.findIndex((transform) =>
        HASH_STANDARDIZE_TRANSFORMS.has(transform)
      );
      if (firstHashIndex >= 0) {
        noteHashedField(entry.field);
      }
      if (firstHashIndex >= 0 && firstHashIndex !== entry.transforms.length - 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['standardize', index, 'transforms', firstHashIndex],
          message:
            'sha256 and hmac_sha256 are terminal transforms; no further transforms may follow',
        });
      }
    });

    const t = spec.thresholds;
    if (t.auto_merge !== null && t.auto_merge <= t.review) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholds', 'auto_merge'],
        message: 'auto_merge must be > review',
      });
    }
    if (t.auto_merge === null && !spec.deterministic_rules.length) {
      // With score-driven auto-merge disabled, deterministic rules are the
      // only remaining merge-edge source — without any, nothing can ever
      // merge and the pipeline is pointless.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholds', 'auto_merge'],
        message:
          'auto_merge: null requires at least one deterministic rule (nothing else can merge)',
      });
    }
    if (t.review < t.auto_reject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholds', 'review'],
        message: 'review must be >= auto_reject',
      });
    }
    if (!spec.deterministic_rules.length && !spec.scoring) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoring'],
        message: 'At least one deterministic rule or scoring config required',
      });
    }
    if (spec.scoring?.method === 'weighted_features') {
      spec.scoring.features.forEach((feature, index) => {
        if (isHashedField(feature.field) && feature.algorithm !== 'exact') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['scoring', 'features', index, 'algorithm'],
            message: `Hashed field "${feature.field}" may only use exact scoring`,
          });
        }
      });
    } else if (spec.scoring?.method === 'fellegi_sunter') {
      spec.scoring.comparisons.forEach((comparison, ci) => {
        if (!isHashedField(comparison.field)) return;
        comparison.levels.forEach((level, li) => {
          if (level.op !== 'exact' && level.op !== 'else') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['scoring', 'comparisons', ci, 'levels', li, 'op'],
              message: `Hashed field "${comparison.field}" may only use exact Fellegi-Sunter levels`,
            });
          }
        });
      });
    }
    spec.semantic_triage?.fields.forEach((field, index) => {
      if (isHashedField(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['semantic_triage', 'fields', index],
          message: `Hashed field "${field}" cannot be used for semantic triage`,
        });
      }
    });
    spec.profile?.attributes?.forEach((attribute, index) => {
      if (isHashedField(attribute.field) && attribute.hashed !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profile', 'attributes', index, 'hashed'],
          message: `Profile attribute "${attribute.field}" references a hashed field and must set hashed: true`,
        });
      }
    });
    if (spec.profile?.display_name) {
      const field = spec.profile.display_name.field;
      if (hashedFields.has(field) || hashedFieldAliases.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profile', 'display_name', 'field'],
          message: `Hashed field "${field}" cannot be used as a display_name`,
        });
      }
    }
    // Escalate mode stacks the panel after the single agent, so the single
    // agent must be enabled to produce the defer / low-confidence pairs that
    // get escalated.
    const panel = spec.agent_policy?.panel;
    if (panel?.enabled && panel.mode === 'escalate' && !spec.agent_policy?.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_policy', 'panel', 'mode'],
        message: "panel.mode 'escalate' requires agent_policy.enabled = true",
      });
    }
  });

export type ResolutionSpec = z.infer<typeof ResolutionSpecSchema>;
