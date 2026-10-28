---
name: entity-graph-authoring
description: Author and iterate on Dogsled OSS entity graph specs. Use when creating or editing resolution, review, survivorship, truthset, or agent task profiles, debugging pair routing, or choosing which current entity graph CLI commands to run.
---

# Entity Graph Authoring

Use this skill for spec authoring and debugging work. For one-shot operational routines, also see [`../entity-graph-resolve/SKILL.md`](../entity-graph-resolve/SKILL.md).

## Start Here

- Read [`../../../docs/entity-graph-authoring-guide.md`](../../../docs/reference/advanced/entity-graph-authoring-guide.md) for the current shipped workflow.
- Read [`../../../docs/guides/entity-graph.md`](../../../docs/guides/entity-graph.md) when the work includes document mentions, generated SDKs, or MCP read tools.
- Use [`../../../packages/model-spec/examples/entity-graph-b2b-company-master/README.md`](../../../packages/model-spec/examples/entity-graph-b2b-company-master/README.md) as the runnable reference project.
- Load [`references/command-map.md`](references/command-map.md) when you need a task-to-command lookup.
- Load [`references/roadmap-status.md`](references/roadmap-status.md) before mentioning simplification-plan commands.

## Operating Rules

- Treat the command registrations in `packages/model-spec/src/commands/` as the source of truth.
- Do not assume `entity-graph quickstart`, `entity-graph fixtures`, `entity-graph unmerge`, `entity-graph suggest thresholds`, `entity-graph explain pair`, `entity-graph scaffold`, `entity-graph diff`, or `resolve run --mode=direct` exist unless the repo actually ships them.
- Prefer `--json` whenever another agent or script needs to consume the output.
- Keep the low-level `resolve`, `review`, `survivorship`, and `truthset` commands as the canonical primitives. Use `entity-graph agent` for bounded one-shot routines, not as a replacement for understanding the pipeline.
- Use `resolve inspect pair`, `resolve inspect cluster`, `review show`, `resolve status`, and `resolve estimate` before changing thresholds or review decisions.
- Run `resolve profile` after `resolve cluster` when downstream consumers need `__entity_profile` or `__entity_quality`.
- Keep SDK entity names stable because they become generated SDK keys.
- Ensure `document` and chunk-shaped entities stay deterministic; do not introduce fuzzy chunk clustering.
- When authoring document-derived relationships, define `relationship_ontology` before `relationship_extraction`; use ontology `relation_type` predicates for public `__entity_relationship`.
- Treat `truthset tune` and `agent truthset-regress` outputs as recommendations for a reviewed spec change, not as an automatic rewrite.

## Default Workflow

1. Scaffold or edit specs in the current spec directory (`entity-graph/` by default).
2. Validate with `resolve validate`, `survivorship validate`, `truthset validate`, and `seed validate` as needed.
3. Compile before execution when you need to inspect SQL or review a change.
4. Run `resolve run`, inspect state, then move through review and clustering.
5. Refresh profiles and survivorship outputs after cluster changes.
6. Use truthsets to regress threshold edits before opening a PR.

## Agent-Facing Guidance

- For a single next step, start with `dogsled entity-graph agent triage ... --json`.
- For review automation, default `agent review-batch` to `--mode propose`.
- Use repo-native task profiles under `entity-graph/agent/*.yml` whenever the repo already stores policy, limits, or output paths.
- If a user asks for the simplification roadmap, distinguish clearly between shipped commands and planned commands.
