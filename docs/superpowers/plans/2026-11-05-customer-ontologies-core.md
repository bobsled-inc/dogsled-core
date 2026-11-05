# Customer Ontologies Core Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks in order. Track completion with the checkboxes below.

**Goal:** Let users author, validate, inspect, edit, and exchange customer ontologies in Dogsled Core.

**Architecture:** Model Spec owns config-only ontology APIs. Project Index discovers files by type. The CLI and MCP adapters call the same APIs. Entity Graph consumes a limited adapter through a public entrypoint.

**Tech Stack:** TypeScript, Zod, Ajv 2020, YAML, Commander, Vitest.

**Spec:** Customer ontology requirements agreed for Core: native YAML anywhere in the project; complete pinned Ossie ontology and mapping shapes; static validation; resolved metadata; safe edits; conversion; CLI, MCP, guides, and skills. Cloud deployment, embeddings, and agent evaluations are separate work.

## Global constraints

- Native files use `spec_version: '0.2'`, `type: ontology` or `type: ontology_mapping`.
- Ontology exchange supports only `0.2.0.dev0`, pinned at `0a908aa87ef093588416dbbcde399f8bdeac00cd`.
- Reject unsupported exports before writes, including mixed exports.
- Preserve semantic-model-only version support and existing relationship extraction behavior.
- No schema downloads, rule execution, or database SDK imports in ontology APIs.
- No ontology root custom extensions; preserve allowed mapping extensions.
- Follow existing guarded paths, bounded parsing, diagnostics, and JSON/YAML output contracts.

## Review focus

- Same version strings can hide schema revision differences: compare pinned semantic schemas and test mixed conversion.
- Case-sensitive and non-ASCII names must survive conversion without unsafe output paths.
- Recursive derivation is valid; cyclic inheritance is invalid.
- Missing model bindings must remain visible and block complete mapping validation.
- MCP reads and previews must not write files or grant access to data.

## Tasks

### 1. Schemas, discovery, and resolved catalog

Files: `packages/project-index/src/kinds.ts`, `packages/model-spec/src/ontology/`, corresponding unit tests.

Interfaces: `parseOntologyDocument(value)`, `loadOntologyCatalog(index)`, `getOntologyContext(catalog, request)`.

- [x] Add failing tests for arbitrary folders, complete standard shapes, duplicate identities, inheritance, relationship roles, identifiers, bounds, and unresolved mappings.
- [x] Pin upstream schemas and their references; derive native envelopes without narrowing standard fields.
- [x] Implement config-only loading, structured diagnostics, and bounded exact retrieval with source hashes.
- [x] Run Project Index and Model Spec focused tests and typechecks.

### 2. Conversion and editing

Files: ontology conversion and editing modules; existing interchange export/import integration; corresponding tests.

Interfaces: conversion uses existing `ConversionResult`; edits return preview content and affected references before writes.

- [x] Add round-trip tests for definitions, embedded mappings, extensions, unsupported versions, mapping scopes, and dependent model references.
- [x] Reuse semantic-model conversion for mapping scopes. Preserve bindings in the allowed versioned extension.
- [x] Add failing filesystem tests for conflicts, path escapes, links, comment preservation, rename, and delete references.
- [x] Implement guarded previews and writes through shared helpers.
- [x] Run conversion and editing regression tests.

### 3. Public API, CLI, and MCP

Files: Model Spec and Dogsled package exports/build entries; `packages/dogsled/src/commands/ontology.ts`; MCP adapter and transport registration; tests.

- [x] Add command and shared-tool tests for project selection, validation, previews, conversion failures, result bounds, and permission enforcement. Smoke-test the MCP stdio transport.
- [x] Expose shared APIs through public package entrypoints; register `dogsled ontology` with JSON/YAML results and shared exit codes.
- [x] Expose the same operations to local MCP clients without requiring database access for config-only work.
- [x] Run command, MCP, and packed-boundary checks.

### 4. Extraction adapter

Files: `packages/entity-graph/` relationship compilation and tests; public ontology adapter API.

- [x] Test qualified relationship references and role bindings, conflicts, unsupported role counts, and derived relationships.
- [x] Resolve supported binary relationships without changing existing extraction behavior.
- [x] Run Entity Graph regression tests.

### 5. Guides, skills, and release checks

Files: ontology guide, API/CLI references, checked examples, `.agents/skills/`, generated manifest, changelog.

- [x] Document authoring, mapping, validation limits, supported versions, editing, and MCP operations.
- [x] Add a built-in skill and regenerate the manifest through its existing command.
- [x] Validate published examples and run `pnpm precommit`.
- [x] Review the final diff for scope, public-safe content, and generated-file drift.

## Verification result

`pnpm precommit`, `pnpm security:fast`, the packed-package check, and the MCP stdio smoke check passed. The repository gate also required removing expired Next.js and qs release-age exemptions. No dependency versions changed.
