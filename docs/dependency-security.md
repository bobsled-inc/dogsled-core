# Installed dependency security

The npm release gate audits the packed package in two clean consumer projects:
all supported optional warehouse drivers at their published minimum versions,
and all at their latest versions allowed by the peer ranges and the one-week
release-age policy. It derives the driver inventory from the internal workspace
manifests. Both installs use npm's `--before` cutoff, disable lifecycle scripts,
and inherit no workspace overrides. The only exception is the exact-version
release-age exemptions below: npm cannot exempt a version from `--before`, so
the audit pins each exempted version to its registry tarball through consumer
`overrides` and checks the installed integrity against the registry. The gate verifies installed driver versions,
rejects independently resolved internal packages, and audits the resulting trees.
The staged AI manifest omits providers already inlined into its built output. Otherwise npm would install duplicate upstream providers with older transitive
provider-utils pins despite the fixed code bundled by Dogsled. Required external
runtime dependencies remain declared, and public imports are smoke-tested.

High and critical advisories fail unless every installed dependency path matches
an unexpired exception in `scripts/security/consumer-exceptions.json`. Exceptions
require an exact advisory, package version, dependency path, reviewed parent SDK versions,
owner, evidence,
review deadline and one of two statuses:

- `not_applicable`: Dogsled cannot reach the vulnerable code, for example because
  it never calls the affected function or never passes it untrusted input.
- `accepted_risk`: Dogsled can reach the vulnerable code. Maintainers have
  reviewed the impact and accept it until the review deadline, usually while a
  fixed version waits out the release-age policy.

An entry without a valid status fails the gate. The report lists each finding
with its advisory, actual installed path, owner, review deadline and disposition:
`not_applicable`, `accepted_risk` or `unhandled`. Only `unhandled` findings fail
the release, and an expired exception leaves its findings `unhandled`.
Registry errors, malformed reports and missing dependency evidence fail closed.
Consumer lockfiles and npm explanations remain local release evidence. The
release report includes audit dispositions and is printed in Actions logs,
uploaded as a seven-day Actions artifact, and attached to the GitHub release.

## Routine version updates

Dependabot opens grouped minor/patch PRs weekly, on Mondays 06:00 UTC (up to 2
for npm, 1 for GitHub Actions), with the same 7-day cooldown. That is just
before the 06:17 UTC [daily release health check](#daily-release-health-check).
Semver-major updates are ignored and stay
manual. Merged dependency PRs carry the `dependencies` Change Type, which does
not release on its own; the next release includes them. A Dependabot PR that
must release gets one `change-type: patch`, `change-type: minor` or
`change-type: major` label (see [releases](releases.md)). Dependabot
security-update PRs stay enabled in repository settings. When a fix version is
younger than the 7-day release age, its PR goes green once the version is old
enough, or the owner adds an exemption if it is urgent.

## Security-fix release-age exemptions

pnpm installs only versions published at least 7 days earlier
(`minimumReleaseAge: 10080` minutes), and the clean consumer audits use the same
cutoff. Lowered from 21 to 7 days on 2026-11-09 (owner decision): major JS
projects use 1--8 days, 7 is the common strict value, Yarn's default is 7, and
known npm hijacks were pulled within hours. Never lowered further without an
owner decision. The only exception is a published
security fix for an advisory that affects Dogsled: the owner may exempt that
exact version (`name@version`, never a name or pattern) in
`minimumReleaseAgeExclude`. Before approval, check that the release comes from
the package's usual publisher, that its registry signature verifies (and its
provenance, where the package publishes one), that it has no install scripts,
and that its diff matches the release notes. Each entry is listed here and
removed once it meets the normal age. A structural test warns when an entry
reaches its removal date and fails after a 3-day grace period, so the cleanup
PR can land before CI turns red. `pnpm deps:expiries` lists all upcoming
expiry dates across exemptions, `audit-ci.json` and consumer exceptions; it
runs early in the Release workflow to fail fast. A structural test also fails
when an entry is not an exact version or is missing from this table.

No exemptions are active. All three previous entries (`body-parser@2.4.0`,
`fast-uri@3.1.9`, `follow-redirects@1.16.2`) met the 7-day release age and
were removed on 2026-11-09.

## Driver security minimums

| Driver                   | Minimum  | Reason                                                                                                                                    |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mysql2`                 | 3.22.0   | GHSA-3f6p-5ww8-9rcr authentication downgrade fix                                                                                          |
| `snowflake-sdk`          | 3.4.0    | Driver credential/logging fixes and TOML 5 minimum                                                                                        |
| `pg`                     | 8.4.0    | Removes pinned vulnerable semver 4.3.2 (GHSA-c2qf-rxjj-qqgw)                                                                              |
| `@databricks/sql`        | 2.0.0    | Uses thrift ^0.23.0, fixing GHSA-r67j-r569-jrwp and GHSA-526f-jxpj-jmg2                                                                   |
| `@google-cloud/bigquery` | 8.1.1    | Reviewed auth chain avoids old gtoken/google-p12-pem/node-forge (GHSA-86w9-cpqp-85rv)                                                     |
| `@aws-sdk/client-s3`     | 3.1017.0 | Reviewed Node driver avoids the old retry dependency's React Native tooling peer chain, including vulnerable braces (GHSA-vfj7-8cjw-p6xm) |

Install these versions or newer supported versions.
Dogsled checks installed versions before loading these SDKs in its default
adapters, queries and connectivity checks. A missing, unverifiable, prerelease
or older driver fails before connection creation. Injected test adapters remain
credential-free. Databricks 1.x is no longer supported. Install 2.x before using
that integration. Native addons still require their usual platform installation.

Snowflake 3.4.0 became age-eligible on 2026-10-21T11:25:23.294Z and requires
`toml ^5.0.0`. This floor fixes the older TOML advisories
GHSA-82x6-q7mm-w9cf and GHSA-v5mp-jgw5-2x6j. TOML 5.0.1 fixes three newer
high advisories. A workspace override and the exemption above pin it, and both
clean consumer trees resolve it within Snowflake's range.

Axios 1.20.0 accepts `follow-redirects ^1.16.0`. Version 1.16.1 became
age-eligible on 2026-10-22T13:52:31.780Z and fixed GHSA-q3jh-wrc6-jgq8 and
GHSA-8r9p-f939-6h3c. Version 1.16.2 fixes GHSA-mrwp-f3q8-3g9p (published
2026-10-25T21:32:25Z; age-eligible 2026-11-15T21:32:25Z). A workspace override
and the exemption above pin it to 1.16.2, and the lockfile resolves 1.16.2 everywhere.

MCP SDK 1.32.0 became age-eligible on 2026-10-23T17:32:51.427Z.
The workspace catalog and lockfile now pin this version, which also supplies the
staged Dogsled runtime dependency. All MCP workspace and consumer exceptions
have been removed.

The exempted versions above replace every undici, Zod, TOML, DOMPurify, Next and
body-parser exception. The catalog pins undici 8.12.2 for Dogsled's own HTTP
clients and Zod 4.6.6 for every package and the npm bundle. The `undici@7`,
`undici@6`, `toml`, `dompurify` and `body-parser` overrides cover the
Turbopuffer, AI SDK, Snowflake, Mermaid and MCP SDK copies, and the clean
consumer trees resolve the same versions.

The published Dogsled manifest leaves optional drivers optional and does not
promote the internal peer declarations. npm can otherwise reject installing
Dogsled in a project that pins an old driver for unrelated work. The bundled
internal manifests declare only other bundled packages: npm treats any other
dependency or peer they declare as part of the bundle when it is installed under
Dogsled, as in a global install, and leaves its folder empty. The top-level
manifest declares every external runtime dependency instead. Missing drivers
are not forced into the project. The runtime checks above reject unsupported
versions when that warehouse is actually used.

## Reviewed exceptions

Owner for each entry: security/release maintainers. Re-review when a driver changes
its dependency tree or integration behavior, even if the deadline has not arrived.
These exceptions describe Dogsled's adapters, not arbitrary direct SDK usage.

- Databricks SQL > proxy-agent > pac-proxy-agent > get-uri > basic-ftp 5.3.1:
  GHSA-c475-qrg2-pj4r affects `Client.list()` parsing of FTP directory listings.
  In Databricks SQL 2.0.0, 2.2.0, 2.3.0 and 2.4.0,
  `dist/connection/connections/HttpConnection.js#getAgent` uses plain HTTP/HTTPS
  agents unless `options.proxy` is supplied. The loader destination, loader
  check command and connections runner pass only host, path and token.
  Regression tests assert those exact options and the absence of `proxy`. The
  PAC/FTP path cannot receive input through these adapters. Re-reviewed on
  2026-11-13: no upstream fix path, because get-uri 8.0.1 still requires
  basic-ftp ^5.3.1 and the fix is only in basic-ftp 6.2.1. Review by 2026-12-20.
  Databricks SQL 3.0.0 keeps that proxy path but its `engines` excludes Node.js
  24.0 through 24.22.0, which Dogsled supports, so the optional peer ranges are
  capped at `>=2.0.0 <3` until maintainers decide to support 3.x.
- Snowflake and Tedious > Azure Identity > MSAL Node: GHSA-xcx6-jx8p-x3h5 is
  resolved. Azure Identity 4.14.1 (published 2026-10-29, age-eligible since
  2026-11-05) uses fixed MSAL Node ^7.1.0. A workspace override pins it and
  the lockfile resolves `@azure/msal-node@7.1.2`. The `audit-ci.json` and
  `consumer-exceptions.json` MSAL entries have been removed.

The `tedious > sprintf-js` advisory is moderate. Tedious uses literal format
strings, so remote values cannot set precision specifiers. It requires no
exception at the high threshold. No generic package-name or severity exception
is used. New dependency paths and expired exceptions block the release.

## Daily release health check

A scheduled GitHub Actions workflow (`release-health.yml`) runs once a day
at 06:17 UTC. It checks for expired exemptions, approaching deadlines, and consumer
audit failures, and fails the job when something needs attention.

### What it checks

- **Expired exemptions**: versions in `minimumReleaseAgeExclude` whose documented
  removal date has passed and should be removed.
- **Approaching deadlines**: `audit-ci` allowlist entries and consumer-exception
  review deadlines within seven days.
- **Consumer audit** (same code `security:release` uses): builds the packed tarball,
  installs it in clean consumer projects with every supported driver combination, and
  audits the resulting trees. Runs twice:
  - **Current cutoff**: catches failures that would block a release today.
  - **3-day look-ahead**: catches driver or transitive versions about to age into the
    release window, before they break a release.

### Consumer finding classification

Unhandled consumer audit findings are classified:

- **Stale exception**: a consumer exception exists for the same advisory, package,
  version and path, but its `parentVersions` does not include the version the
  consumer tree now resolves. This happens when an optional driver publishes a new
  version that pulls in the same transitive tree. The report names the exact
  exception and parent version to add.
- **New finding**: no matching exception exists at all. The report includes the
  advisory, package, version and severity. A person writes the exception or fix.

### Settings

The repository variable `RELEASE_HEALTH` controls behavior:

| Value          | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `off` or unset | The workflow exits immediately.                                  |
| `on`           | Full health check runs. Job fails on expired or unhandled items. |

The workflow also uses:

- Variable `HUSKY_ORIGIN`: the base URL for the Husky API. When unset, the report
  is written to the step summary and uploaded as an artifact, but no POST is made.
- No Slack tokens or GitHub App tokens. The audit job that runs third-party code
  has `contents: read` only. A separate report job holds `id-token: write` to
  mint the Husky OIDC token, and runs no third-party code. Slack posting is
  handled by Husky on its side.

### Husky hand-off

The health check builds a `health-report.json` in the Husky contract schema (v1):
typed findings with only validated fields (npm package names, semver versions,
GHSA IDs, ISO dates, and a fixed file-path allow list). No free text from the
registry or audit output ever reaches the report.

When `HUSKY_ORIGIN` is set, the workflow requests a GitHub OIDC token with audience
`husky` and POSTs the report to `${HUSKY_ORIGIN}/api/health/report`. Husky verifies
the token, posts maintainer messages, and may open a draft fix PR for any finding
kind. A person still reviews and merges; deadline, exception, compatibility and
security-reachability judgments need explicit human approval.

The report content is built by the audit job, which runs third-party dependency
code (install, build, consumer installs). The report job POSTs it as-is. This means
a malicious dependency could forge report content. The risk is bounded by Husky's
schema validation (strict field patterns, fixed file-path allow list), the 50-finding
cap, the fact that fix PRs open as drafts, and the CODEOWNERS requirement on the
target files in core's main branch ruleset.

### Code

The scripts live in `scripts/deps/`:

- `planner.mjs` — pure functions (classification, validation, contract findings builder).
- `health-check.mjs` — CLI entry: reads expiries, builds report, POSTs to Husky.
- `consumer-check.mjs` — builds tarball, runs consumer audit, classifies findings.
