# Security Policy

## Supported versions

Security fixes target the latest released `0.x` minor of Dogsled. Older minors
are unsupported. Maintainers may ask reporters to reproduce a finding on the
latest patch within that minor.

## Reporting a vulnerability

Report vulnerabilities to `security@dogsledai.com` or use
[GitHub private vulnerability reporting](https://github.com/bobsled-inc/dogsled-core/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include the affected version, command or configuration, reproduction steps, the
impact and required preconditions, and any disclosure deadline. Use synthetic
data and omit credentials and secrets.

Maintainers aim to acknowledge reports within three business days and provide
updates until resolution. Coordinate public disclosure with the maintainers
for up to 90 days so a fix and advisory can be prepared. If more time is needed
for an upstream fix or complex investigation, maintainers will discuss the
schedule with the reporter.

GitHub Security Advisories support private coordination, CVE requests and
publication. Reporters may request attribution or anonymity.

## Scope

Useful reports include credential disclosure, unsafe command execution,
filesystem traversal, SQL injection, SSRF and redirect bypasses, parser denial
of service, authorization failures, and supply-chain or release-integrity bugs.
Documented opt-ins do not excuse unsafe defaults or bypasses of their boundary.

Project reviewer commands execute local programs with user privileges, without a shell and with an allowlisted environment.

Treat integration and webhook YAML from others like code: credential references require `auth_env_vars` (or bundled integration `meta.yml` declarations), while explicit host declarations can authorize only names in a supplied credential map or resolver.

## Release security

The [Release workflow](.github/workflows/release.yml) runs only in
`bobsled-inc/dogsled-core`, from `main`. A maintainer dispatches it, or, when the
`AUTO_RELEASE` variable is `on`, the [Release on merge workflow](.github/workflows/release-on-merge.yml)
dispatches it in `auto` mode after a pull request merges. That trigger reads the
merged pull request through the API with code from the merge commit on `main`,
never checks out the pull request head and has no secrets. The increment comes
from each merged pull request's Change Type, and maintainers can also choose one
or retry an existing immutable tag.

The workflow builds and checks one tarball containing 15 internal packages,
checks bundled third-party notices, performs a clean install and a real
CSV → DuckDB → query smoke test, and records SHA-256 and SHA-512 integrity plus
a CycloneDX SBOM. The artifact gate also runs the dependency audit.

A separate protected job publishes the exact reviewed tarball using npm trusted
publishing (OIDC). Public releases require provenance. The workflow rejects
mismatches between repository visibility and reviewed package access.

Only the protected publish job has `id-token: write`. It has read-only repository
access. Actions and the npm publishing client are pinned, and publishing jobs
disable package-manager caching. Successful publishes and already-published retries
must match the reviewed tarball's registry integrity. Missing or mismatched
integrity fails the release. Successful releases attach the reviewed artifact
report and SBOM. Preview versions use the `preview` dist-tag and GitHub prerelease flag.

The workflow relies on required environment reviewers, publication limited to
`main`, and `v*` tag creation limited to the release workflow with replacement
and deletion blocked. npm's trusted publisher is bound to this repository,
`release.yml` and `npm-release`. Preparation has read-only repository access.
A maintainer approves the release in the `release-approval` environment before
any tag is pushed; a rejection leaves no tag. The install-free tag job then runs
in the `release-tag` environment, limited to `main` without reviewers, and
pushes the verified tag with Git hooks disabled. Publication runs in `npm-release`.
Follow [Cutting a release](docs/releases.md) for dispatch, approval, and
verification steps.

## Dependency checks

`pnpm security:audit` queries the registry using `audit-ci.json`. CI runs it
every Monday at 10:17 UTC while GitHub schedules remain active, on pushes to
`main`, and on manual dispatch when
`dependency_audit` is enabled. Release artifact checks run it as well. Pull
request checks keep the network audit separate from the local development gate.

Dependency updates observe a 7-day minimum release age, except for
owner-approved exact-version security-fix exemptions listed in
`docs/dependency-security.md`. Weekly Dependabot npm
and GitHub Actions updates use the same cooldown, group minor/patch updates and
ignore semver-major bumps. npm allows up to two open version-update PRs;
GitHub Actions allows one. Audit exceptions
identify an exact
advisory and dependency path, explain reachability, and set a review deadline.

`pnpm security:fast` is the offline gate for tracked secrets, privacy and naming
rules, undeclared telemetry, registry policy, lifecycle scripts and targeted
security properties. `pnpm precommit` runs the normal build, code and test gates.

Before publication, maintainers review dependency licenses, the package
inventory and scanner evidence. Raw scanner reports remain ignored local files.
Release artifact reports include
consumer audit dispositions and are printed in Actions logs, retained as seven-day
Actions artifacts, and attached to GitHub releases with the SBOM. Scheduled
workflows can stop after 60 days without repository activity. Maintainers must
re-enable the schedule or dispatch an audit manually.
