---
name: open-source-security-review
description: Review Dogsled security and privacy changes with deterministic checks and regression tests.
---

# Security and privacy review

Use this skill when a change affects credentials, network access, filesystem
access, subprocesses, dependencies, or data retention.

1. Read the nearest `AGENTS.md` and the affected implementation and tests.
2. Identify the inputs, trust boundaries, data flows, and caller permissions.
3. Check containment, redaction, timeouts, resource limits, and error handling.
4. Add a regression test for each confirmed bug at the affected boundary.
5. Run `pnpm security:fast`, focused tests, and `pnpm precommit`.
6. Report confirmed findings with their impact, location, fix, and test evidence.

Run `pnpm security:audit` when dependency changes need a networked advisory check.
Use the release checks documented in `docs/releases.md` before publishing.

Keep raw scanner output in the gitignored `.security-review/` directory. Review
and redact diagnostics before sharing them. Report vulnerabilities through
`SECURITY.md`. Never upload credentials, customer data, or raw scanner output.
