# Retail Tutorial Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship a retail tutorial beside TV Night through the same entry skill and engine.

**Architecture:** Register a built-in retail definition. Bundle a clean synthetic starter, keep completed models in excluded references, and route the existing entry skill to tutorial-specific lessons. Reuse the shared progress and HTML code.

**Tech Stack:** TypeScript, YAML, Node.js 24, DuckDB, Vitest, existing Dogsled packages.

**Spec:** docs/superpowers/specs/2026-10-30-retail-tutorial-design.md

## Global Constraints

- No new dependencies or external services.
- Real AI follows TV Night consent, pilot, budget and retry controls.
- No live AI calls under the earlier TV Night allowance.
- Preserve legacy TV Night behavior and use only built-in tutorial code.
- Keep API HTTPS and loopback-only; never disable TLS verification globally.
- Sign off every commit; target the shared-framework branch in a draft PR.

## Review Focus

- A fresh learner project must not contain completed models or runtime state.
- Resume must choose the saved tutorial, including legacy TV Night projects.
- A pilot must not complete a chapter or rewrite progress.
- Support cases with ambiguous product identity must remain null.
- Offline fixture output must not be represented as real AI evidence.

### Task 1: Retail starter and chapter checks

**Files:** Create `packages/dogsled/examples/retail/`, `packages/dogsled/src/runtime/onboarding/tutorials/retail/{index,checks,content,display}.ts`, and `packages/dogsled/tests/unit/onboarding/retail.test.ts`. Modify the registry in `tutorials.ts`.

**Interfaces:** Export `retail: TutorialDefinition`; retain the shared interface. The example uses `data/retail/manifest.json`, `data.duckdb`, and six standard chapter IDs.

- [ ] Write tests asserting retail registration, clean example copy without reference models, retail rendering without TV terms, rejection of incomplete or invalid chapter evidence and mismatched identities.
- [ ] Run `pnpm --filter @bobsled-inc/dogsled test:unit tests/unit/onboarding/retail.test.ts`; expect missing-retail failures.
- [ ] Adapt synthetic fixtures and configs; put all completed models in `reference/`. Implement the built-in definition and meaningful chapter checks.
- [ ] Run the onboarding unit directory; expect all tests pass.
- [ ] Commit with DCO sign-off.

### Task 2: Tutorial routing and pilot execution

**Files:** Modify `.agents/skills/dogsled-get-started/SKILL.md`, create `.agents/skills/dogsled-retail/SKILL.md`, update onboarding CLI and tests, add retail reference executor and classification models.

**Interfaces:** Existing generic skill selects or resumes tutorials. Retail guide is available with `onboarding guide --tutorial retail`. Add `--ticket-id` for a safe string-key retail pilot without changing `--show-id` behavior.

- [ ] Write CLI tests for retail guide and pilot options, plus pilot no-write and classification evidence tests.
- [ ] Run focused tests; expect failures for the missing ticket pilot behavior.
- [ ] Add selection and resume instructions without duplicating the shared workflow. Add retail lessons and exact source/model commands; keep consent rules aligned with TV Night.
- [ ] Implement validated ticket pilot handling, real AI executor budget controls, and a maximum five-case batch with nullable product identity and exact supporting quotes.
- [ ] Run onboarding tests and executor tests; expect all pass, including legacy TV Night and pilot state preservation.
- [ ] Commit with DCO sign-off.

### Task 3: Full walkthrough and distribution verification

**Files:** Add integration coverage under `packages/dogsled/tests/integration/`; update `docs/guides/retail.md`, CLI reference and changelog, plus necessary catalog generation through existing scripts.

**Interfaces:** Use the public CLI and copied starter from Task 1; real AI is mocked for deterministic tests.

- [ ] Add an integration scenario that starts with the starter, runs local HTTPS API/warehouse/model/federation checks and verifies ambiguous support identity and offline distinction.
- [ ] Run it and fix failures at their source, with regression coverage.
- [ ] Check the retail HTML and TV Night page in a browser; exercise chapter navigation and evidence previews.
- [ ] Run `pnpm security:fast` and `pnpm precommit`; expect success.
- [ ] Review the whole diff with a fresh reviewer, resolve material issues and commit with sign-off.
- [ ] Push and open a draft stacked PR against `codex/shared-tutorial-framework`, then attach it to this chat.
