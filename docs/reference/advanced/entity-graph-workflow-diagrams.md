# Entity Graph Workflow Diagrams

Visual reference for the entity graph identity pipeline — phases, artifact tables, review paths, and the default company sandbox.

---

## 1. Overall Pipeline Architecture

The three execution phases, the CLI commands that trigger them, and how review decisions feed back into clustering. Current serving outputs use stable `entity_id`; `component_id` captures the current connected-component shape.

```mermaid
flowchart TD
    subgraph SRC["Source Systems  (2 – N tables)"]
        sa[(Source A)]
        sb[(Source B)]
        sn[(...Source N)]
    end

    subgraph PH1["Phase 1 — RESOLVE       dogsled entity-graph resolve run"]
        std["Standardize"]
        blk["Block"]
        scr["Score"]
        thr["Threshold Route"]
        std --> blk --> scr --> thr
    end

    subgraph PH2["Phase 2 — CLUSTER       dogsled entity-graph resolve cluster"]
        rev{Review}
        cmp["Connected Components\ncurrent graph topology"]
        sid["Stable Entity IDs\nappend events + rebuild snapshots"]
        xwk["Crosswalk"]
        rev --> cmp --> sid --> xwk
    end

    subgraph RPATH["Review Paths"]
        hr["Human Review\nexport CSV → decide → apply"]
        ag["Agent Review\nbatch LLM → auto-apply or escalate"]
    end

    subgraph PH3["Phase 3 — PROFILE       dogsled entity-graph resolve profile"]
        prf["Entity Profile\n+ Trust Score\n+ Activation Projections"]
        srv["Survivorship\n→ Golden Record"]
    end

    SRC --> std
    thr -->|"entity__review_queue"| RPATH
    thr -.->|"auto-merge edges\nscore >= auto_merge"| clu
    RPATH -->|"entity__review_decisions"| rev
    xwk --> prf
    xwk --> srv
    prf --> OUT[/"Downstream  BI · CRM · Marketing"/]
    srv --> OUT
```

### CLI quick reference (company sandbox)

The sandbox lives in `workspace/entity-graph-demo`; run these commands from that directory.

```bash
# Phase 1 — run the full resolve pipeline (standardize → block → score → threshold)
dogsled entity-graph resolve run company --runner ./runner.duckdb.js

# Phase 2 — export the review queue, fill in decisions, re-import, then cluster
dogsled entity-graph review export company --format csv --output company_review.csv
# edit company_review.csv: set `decision` column to merge | not_match | defer
dogsled entity-graph review apply --entity company --input company_review.csv
dogsled entity-graph resolve cluster company --runner ./runner.duckdb.js

# Phase 3 — build entity profiles and golden records
dogsled entity-graph resolve profile company --runner ./runner.duckdb.js
dogsled entity-graph survivorship run company --runner ./runner.duckdb.js
```

**Spot-check queries against company sandbox tables (DuckDB / schema `entity_graph_demo`):**

```sql
-- How many standardized records per source?
SELECT _source_system, COUNT(*) FROM entity_graph_demo.company__standardized GROUP BY 1;

-- Distribution of match types from scoring
SELECT match_type, COUNT(*) FROM entity_graph_demo.company__pair_scores GROUP BY 1;

-- Review queue: top candidates by score
SELECT pair_id, composite_score, recommended_action, field_diffs
FROM entity_graph_demo.company__review_queue
ORDER BY composite_score DESC LIMIT 20;

-- Entity size distribution
SELECT entity_id, COUNT(*) AS members
FROM entity_graph_demo.company__clusters
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- Golden record for a specific entity
SELECT attribute_name, attribute_value, source_system
FROM entity_graph_demo.company__golden_record
WHERE entity_id = '<entity_id>';
```

---

## 2. Phase 1 — Resolve: Steps and Artifact Tables

Each step produces an intermediate table consumed by the next stage. Scoring joins back to `__standardized` for field values.

```mermaid
flowchart LR
    src["Source Tables\nUNION ALL"] --> std

    std["1 · Standardize\nNormalize per-field\nlowercase · trim · digits_only\nstrip_legal_suffixes · strip_protocol\nAdd record_id + source_ref"]

    std --> t_std[("entity__standardized\nrecord_id · source_ref\nstandardized_* fields\n_source_system\n_standardized_at")]

    t_std --> blk

    blk["2 · Block\nCompute key per rule\nOR across all rules\nPairs sharing any key → candidate\nCap at candidate_limit"]

    blk --> t_cand[("entity__candidate_pairs\nrecord_a_id · record_b_id\nsource_a · source_b\nblocking_rules JSON")]

    t_cand --> scr
    t_std --> scr

    scr["3 · Score\nDeterministic rules first:\n  if conditions fire → auto_merge\nOtherwise weighted fuzzy:\n  jaro_winkler · exact · soundex\n  numeric_distance · date_proximity\nComposite = sum of score x weight"]

    scr --> t_scores[("entity__pair_scores\npair_id · composite_score\nmatch_type · rule_name\nfield_scores JSON · blocking_rules")]

    t_scores --> thr

    thr["4 · Threshold Route\nscore >= auto_merge  → auto-merge edge\nscore >= review      → review_queue\nscore >= auto_reject → re-evaluate pool\nbelow auto_reject    → discard\nAdds recommended_action heuristic"]

    thr -->|"auto-merge edges\nto Phase 2 clustering"| clus_out(["Phase 2 Cluster"])
    thr --> t_queue[("entity__review_queue\npair_id · composite_score\nthreshold_band · field_diffs\nrecommended_action")]
```

---

## 3. Phase 2 — Review and Cluster: Steps and Artifact Tables

Auto-merge edges and review decisions are combined before clustering. Review is optional — pairs routed to the queue can be handled by human reviewers, the LLM agent, or both. The connected component is then mapped to a stable `entity_id` before serving tables are rebuilt.

```mermaid
flowchart TD
    t_scores_in[("entity__pair_scores\nauto-merge pairs")]
    t_queue_in[("entity__review_queue\nreview-band pairs")]

    subgraph HR["Human Review"]
        hexp["dogsled entity-graph review export\n--format csv"]
        hdec["Reviewer decides\nmerge · not_match · defer"]
        happ["dogsled entity-graph review apply\n--input review.csv"]
        hexp --> hdec --> happ
    end

    subgraph AR["Agent Review"]
        abatch["Query review_queue\nbatch context fields"]
        allm["Invoke LLM (Claude Sonnet)"]
        aconf{"confidence\n>= auto_apply_threshold?"}
        aauto["Auto-apply decision"]
        aesc["Escalate to human"]
        abatch --> allm --> aconf
        aconf -->|Yes| aauto
        aconf -->|No| aesc
    end

    t_decisions[("entity__review_decisions\ndecision_source  agent / human\ndecision  merge / not_match\nconfidence · status\n(append-only log)")]

    clu["Connected Components\nUnion-Find on all merge edges:\n1. Auto-merge pairs from __pair_scores\n2. merge decisions from __review_decisions\ncomponent_id = MIN(record_id) in current component"]

    sid["Stable Entity ID Assignment\nAppend entity ID events\nOldest ID wins on merge\nAnchor ID preserved on split\nAliases track merged IDs"]

    t_clusters[("entity__clusters\nentity_id · cluster_id · component_id\nrecord_id · source_ref · source_system\nconfidence_score · clustered_at")]

    xwk["Crosswalk\nMap every source record to stable entity_id\nEasy join surface for downstream consumers"]

    t_xwk[("entity__crosswalks\nrecord_id · source_ref\nsource_pk_json\nentity_id · cluster_id · component_id\nconfidence_score · matched_at")]

    t_queue_in --> HR & AR
    HR & AR --> t_decisions
    t_decisions -->|"merge decisions"| clu
    t_scores_in -->|"auto-merge pairs"| clu
    clu --> sid --> t_clusters --> xwk --> t_xwk
    t_xwk --> PH3(["Phase 3 Profile"])
```

---

## 4. Phase 3 — Profile and Survivorship: Steps and Artifact Tables

Profile and survivorship run from the crosswalk + standardized data. They are independent of each other and can run in parallel.

```mermaid
flowchart TD
    inputs[("entity__crosswalks\nentity__standardized\nentity__clusters\nstable entity_id")]

    subgraph EP["Entity Profile"]
        ep_op["Aggregate attributes per cluster\nRespect source precedence order\nSelect display_name from preferred source\nBuild profile_attrs JSON blob"]
        ep_t[("entity__entity_profile\nentity_id · cluster_id · display_name\nprofile_attrs JSON\nsource_count · record_count\nentity_confidence · effective_at")]
        ep_op --> ep_t
    end

    subgraph EQ["Trust Score"]
        eq_op["Identity confidence  (cluster assignment strength)\nFreshness score     (time-decay from observed_at)\nSource diversity    (distinct sources / total possible)\nAttribute coverage  (populated fields / expected fields)\nComposite entity_trust_score → BRONZE / SILVER / GOLD tier"]
        eq_t[("entity__entity_quality\nidentity_confidence · freshness_score\nsource_diversity_score\nattribute_coverage\nentity_trust_score · trust_tier\nscored_at")]
        eq_op --> eq_t
    end

    subgraph ACT["Activation Projections"]
        act_op["Flatten profile_attrs JSON\nJoin with identity maps\nProject to named downstream schema\nOne table per activation definition"]
        act_t[("entity__activation__projection_*\ncustomer_master_id\ndownstream-ready columns")]
        act_op --> act_t
    end

    subgraph SRV["Survivorship"]
        srv_op["Per attribute, apply strategy:\nsource_priority  → prefer source order\nrecency          → most recently updated\nmost_common      → majority vote\nmost_complete    → longest non-null value\nvalue_priority   → prefer value ranking\npinned_value     → force constant"]
        gld_t[("entity__golden_record\nentity_id · cluster_id · attribute_name\nattribute_value · source_system\nupdated_at  (append-only)")]
        ghist_t[("entity__golden_history\nold_value · new_value\nchange_type · changed_at\n(audit trail)")]
        srv_op --> gld_t
        srv_op --> ghist_t
    end

    inputs --> EP & EQ & ACT & SRV
    ep_t & eq_t & act_t & gld_t --> DS[/"Downstream  BI · CRM · Marketing"/]
```
