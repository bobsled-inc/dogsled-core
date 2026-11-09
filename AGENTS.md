# Dogsled — Agent Guide

<!-- last-reviewed: 2026-10-28 -->

Dogsled is an agent-native, open-source data engineering toolkit. Keep this guide
limited to durable rules that are difficult to infer from code, tests, or public
documentation. Roadmaps and launch status belong in issues.

## Working In This Repository

- Start from updated `main` and work on a descriptive feature branch unless the
  repository workflow explicitly calls for direct changes to its default branch.
- Read `CONTRIBUTING.md` and the nearest `AGENTS.md` before changing an app or package. Closer guides may
  add local constraints but must not repeat or weaken this file.
- Run `pnpm agent:context` to discover applicable guides, skills, risks, and focused
  checks for the current diff.
- Inspect existing code and tests before editing, preserve unrelated user changes,
  and implement the request end to end with tests and relevant documentation.
- Use repository formatters and package-local checks while iterating, then run
  `pnpm precommit`.
- Review the final diff for accidental scope, secrets, generated-file drift, and
  stale docs. When the task asks you to ship: commit, push and open a draft PR.
  Never enable auto-merge or dismiss reviews.
- Keep commits logically focused and use imperative messages that explain why.

Do not add model-specific instruction files. For Dogsled's own Built-in Skills,
`.agents/skills/` is the only authored source and `.claude/skills` is a compatibility
symlink. Project Skills in a user's Dogsled project are separate authored content under
that project's `skills/` directory.

## Architecture Contracts

### Protocol

- stdout carries data messages such as `SCHEMA`, `RECORD`, `STATE`, and `BATCH`.
- stderr carries structured control messages such as `LOG` and `METRIC`.
- Extractors, enrichers, and loaders remain independently composable.

Never mix human logging into stdout or add a private side channel between pipeline
components.

### Configuration And Packages

- Pipeline behavior belongs in versioned YAML or Markdown.
- Secrets use environment indirection and must not be persisted in configuration,
  logs, state, fixtures, or generated artifacts.
- Package boundaries are contracts. Import through workspace entrypoints, not
  cross-package relative paths.
- Derive types from canonical schemas and reuse shared connection, protocol, output,
  and error contracts.
- Load optional provider and database SDKs dynamically.
- Update generated sources through their documented regeneration command.

## Code Standards

- Use direct imports for local dependency-light commands and subprocess delegation
  when native dependencies or process isolation are required.
- Preserve backward compatibility unless a breaking change is explicitly authorized
  and includes migration guidance.
- Agent-consumable results support equivalent `--json` and `--yaml` output. Streaming
  protocols, structured event streams, and fixed external contracts are exceptions.
- Controlled CLI failures use shared error contracts and exit codes: `0` success,
  `1` runtime failure, `2` validation failure, and `3` detected drift.
- Source code uses repository formatters instead of `console.*` and sets
  `process.exitCode` rather than calling `process.exit()`.

## Working In Public

Everything in this repository is public and permanent: commits, branch names, pull
request titles and descriptions, review comments, issues, CI logs and artifacts,
release notes, and every published npm version.

- Never commit credentials, private registry configuration, customer data, employee
  PII, `.env` files, or raw scanner output. Secret-shaped test values, even fake ones,
  follow the existing fixture conventions: deliberate invalid credentials stay in the
  files listed in `.secretlintignore`, and other fixtures use the reserved domains and
  synthetic values described in `docs/privacy-guard.md`.
- Never include non-public context: names of customers, users, or employees; internal
  hostnames or URLs; links to private chat, documents, or ticket systems; private
  repository names; or internal ticket ids. Use fictional examples such as
  `example.com` and "Acme".
- Keep commit messages and pull request descriptions self-contained and safe to
  publish. Internal motivation stays in internal tools.
- Never weaken the security and privacy guards, the rule that credential references
  are declared (`auth_env_vars`), or the 7-day dependency release age, which is never
  lowered further without an owner decision and is bypassed only by owner-approved
  exact-version security-fix exemptions listed in `docs/dependency-security.md`.
- Report vulnerabilities and coordinate their fixes only through `SECURITY.md` and
  private security advisories, never in a public issue, pull request, or commit
  message, until a fix is released.
- Sign off every commit for the DCO (`git commit -s`) and select exactly one Change
  Type in the pull request template.

## Security And Privacy

- Treat paths, URLs, headers, SQL identifiers, subprocess arguments, decoded
  responses, archives, and remote metadata as untrusted.
- Reuse existing containment, SSRF, redaction, size-limit, and command-shape helpers.
- Require HTTPS for OAuth/token endpoints and reject header newline injection.
- Parameterize values and quote identifiers with dialect-aware helpers.
- Bound retries, redirects, response sizes, parser work, and temporary storage.
- Use exact reviewed subprocess shapes; never widen an allowlist into general shell
  execution.
- Do not add telemetry, analytics, remote error reporting, or Dogsled-operated
  endpoints without an explicit privacy review and documentation update.

Security-sensitive changes require regression coverage at the affected trust
boundary. Use `.agents/skills/open-source-security-review/SKILL.md` for release
review work.

## Testing And Documentation

- Every behavior change needs coverage; every bug fix needs a regression test.
- Unit tests remain deterministic, mocked, and independent of external credentials.
- Live service and native database scenarios belong in integration suites.
- New sources and destinations need mocked execution coverage when live credentials
  are unavailable.
- Integration specifications must validate structurally and resolve review markers.
- Preserve root test sequencing: run at most two other workspace suites at once,
  then run the Dogsled suite. Each suite can start its own workers; unbounded
  package concurrency can exhaust small CI runners.
- `pnpm precommit` is the required repository gate.

Keep package/app guides short and local: purpose, boundaries, non-obvious invariants,
security constraints, and verification commands. Do not duplicate READMEs, file
trees, roadmaps, command catalogs, release status, or repository-wide delivery
rules. Update the nearest guide when a durable convention changes.
