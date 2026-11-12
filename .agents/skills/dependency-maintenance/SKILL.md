---
name: dependency-maintenance
description: Fix Dogsled dependency findings (release-age exemptions, consumer-audit exceptions, overrides, advisories, Dependabot PRs and third-party notices) under the repository's dependency rules.
---

# Dependency maintenance

Use this skill for a daily health check finding, a failing release audit, a
Dependabot PR, or any change to `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`audit-ci.json`, `scripts/security/consumer-exceptions.json` or the third-party
notices. The policy itself lives in `docs/dependency-security.md`; read it first.
Step-by-step fixes are in [references/playbooks.md](references/playbooks.md).

## Hard rules

- Keep this maintainer-only: do not add `exposed: true`. The bundled Skills
  manifest and installable agent plugins must not include this skill.
- Never lower, bypass or work around `minimumReleaseAge` (7 days). No new
  `minimumReleaseAgeExclude` entry without an owner decision; exemptions are
  exact `name@version` security fixes only.
- Never add or widen an exception (new advisory, version, path or parent
  version, later expiry) without evidence: the published tarball reviewed and
  the unreachable or accepted code path named.
- Change only what the finding needs. No unrelated upgrades, refactors or
  lockfile churn.
- Everything is public: no names of people or customers, internal links,
  hostnames or ticket ids in files, commits or PR text. Do not discuss an
  undisclosed vulnerability in public; use `SECURITY.md`.
- Sign off every commit (`git commit -s`) and pick exactly one Change Type.

## How the system works

- **Release age.** `minimumReleaseAge: 10080` in `pnpm-workspace.yaml` makes pnpm
  install only versions published at least 7 days ago. The consumer audit uses
  the same cutoff through npm `--before`.
- **Exemptions.** `minimumReleaseAgeExclude` holds owner-approved exact
  versions. Each one has a row with a removal date (publish time + 7 days) in the
  exemptions table of `docs/dependency-security.md`. The structural test warns at
  the removal date and fails 3 days later.
- **Overrides.** `overrides` in `pnpm-workspace.yaml` pin fixed transitive
  versions inside this workspace only. Published consumers never see them.
- **Workspace audit.** `pnpm security:audit` runs audit-ci on the lockfile at
  `high`, with `audit-ci.json` as its allowlist.
- **Packed-consumer audit.** Packs `@bobsled-inc/dogsled`, installs it in clean
  npm projects with every optional warehouse driver at its oldest (`floor`) and
  newest (`latest`) version allowed by the internal peer ranges and the release
  age, and audits those trees. This is what a user's install resolves, so it can
  differ from the lockfile: a new driver release can enter the `latest` tree
  without any change here. High and critical findings fail unless every path
  matches an unexpired entry in `scripts/security/consumer-exceptions.json`
  (exact advisory, package version, path, and the reviewed `parentVersions`).
- **Daily health check.** `.github/workflows/release-health.yml` runs
  `pnpm deps:expiries`-style expiry checks plus the consumer audit at today's
  cutoff and again 3 days ahead, then reports four finding kinds:
  `expired_exemption`, `deadline_soon`, `stale_parent` and `new_finding`.
  The report goes to the maintainers' automation, which may open a draft fix PR
  for any finding kind. People review and merge; deadline, exception,
  compatibility and security-reachability judgments need explicit human approval.
- **Release gate.** The Release workflow runs `pnpm deps:expiries --fail-within 0`
  first, checks third-party notices, and runs `pnpm security:release --execute`
  (workspace audit, packed tarball checks, SBOM, consumer audit).
- **Dependabot.** Weekly grouped minor and patch PRs (2 npm, 1 Actions) with a
  7-day cooldown; majors stay manual. Security-update PRs are on. A fix younger
  than 7 days goes green once it ages in. Dependabot PRs release as
  `dependencies`.
- **Third-party notices.** `packages/dogsled/THIRD_PARTY_NOTICES.md` is generated
  from the bundled build inputs. CI and releases fail when it is stale.

## Pick a playbook

| Signal                                                        | Playbook                  |
| ------------------------------------------------------------- | ------------------------- |
| `expired_exemption`, or structural test fails on an exemption | Expired exemption         |
| `deadline_soon` for an exemption, audit-ci or exception entry | Deadline soon             |
| `stale_parent`, or a release audit fails on a new driver      | Stale parent              |
| `new_finding`, or an `unhandled` advisory in an audit         | New advisory              |
| Dependabot PR to review                                       | Reviewing a Dependabot PR |
| CI fails with "Third-party notices are missing or stale"      | Stale third-party notices |
| Build fails because an override pins a too-old version        | Override bump             |

## Commands

```bash
pnpm install --frozen-lockfile
pnpm deps:expiries                      # every exemption, allowlist and exception date
pnpm deps:expiries --fail-within 7      # non-zero if anything is due within 7 days
pnpm security:audit                     # workspace lockfile audit
pnpm build && pnpm run setup:sqlite     # required before the consumer audit
node scripts/deps/consumer-check.mjs --output /tmp/health-check --lookahead-days 3
node scripts/deps/health-check.mjs --output /tmp/health-check
node scripts/release/third-party-notices.mjs           # regenerate after a build
node scripts/release/third-party-notices.mjs --check   # verify
pnpm test:structural
pnpm check
```

`consumer-check.mjs` writes `consumer-findings.json` and `consumer-report.json`
and keeps each install's npm evidence under `consumer-current/` and
`consumer-lookahead/`. `health-check.mjs` then writes the same
`health-report.json` the daily job sends; it exits non-zero when it has findings.
Raise `--lookahead-days` to prove a fix against a future cutoff.

## Pull requests

Follow `.github/pull_request_template.md` and the `pr-template` skill. State the
finding, the root cause, the change, and the evidence: registry publish times,
tarball review notes, and the commands above with their results, including the
consumer audit at the current and look-ahead cutoffs. Change Type: `internal`
for policy-file changes (exemptions, exceptions, audit config), `dependencies`
for version, override or lockfile changes, `patch` when users see different
behavior, such as a raised runtime driver minimum.
