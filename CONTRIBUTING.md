# Contributing to Bobsled Core

Thank you for helping improve Bobsled Core. We currently focus outside code contributions
on small fixes: roughly twelve changed lines whose complete effect a maintainer can
check by reading the patch. We are not seeking broader outside implementation work.

AI makes producing code faster. Reviewing a change and keeping the whole product
consistent still takes careful attention, so our maintainers and agents implement
accepted ideas. Please share useful problems and proposals even when they need a
larger change. We may revise this policy as the project matures.

## What is welcome

- Report reproducible bugs in [GitHub issues](https://github.com/bobsled-inc/bobsled-core/issues/new/choose).
- Discuss ideas, features and connector requests in [GitHub Discussions](https://github.com/bobsled-inc/bobsled-core/discussions).
  For a connector, describe the API or system, authentication type, objects needed
  and a synthetic response shape in the [connector request form](https://github.com/bobsled-inc/bobsled-core/discussions/new?category=connector-requests).
- Submit a small fix when reading the patch is enough to establish that it is
  correct. Explain the concrete bug and why every effect is easy to verify.

Maintainers close larger patches and low-value changes, including typo-only PRs,
with a link to this policy. Meeting a line count does not guarantee acceptance;
maintainers decide whether a fix fits. The contribution-policy workflow only
adds a label and one notice when an outside PR exceeds the guide. It never closes a PR.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Keep security reports private:
use the contact and private reporting instructions in [SECURITY.md](SECURITY.md), never a public issue or discussion.
Do not include credentials, customer details or private data in any submission.

## Sign off accepted fixes

Bobsled Core remains Apache-2.0. Contributions submitted for inclusion use that license
and require the [Developer Certificate of Origin, version 1.1](https://developercertificate.org/).
A sign-off certifies that you have the right to submit the contribution under that
certificate. Read it before signing; a sign-off is not a cryptographic signature.

Add your own sign-off to each commit:

```bash
git commit -s
```

For a missing sign-off on your latest unpublished commit:

```bash
git commit --amend --no-edit -s
```

For your own commits on a PR branch, use an interactive rebase against the current
upstream base and amend each unsigned commit. If already pushed, coordinate with
collaborators before pushing the rewritten branch with `--force-with-lease`.
Do not sign off on someone else's behalf or rewrite the shared default branch.

## Develop and verify a small fix

Use Node.js 24 or newer and pnpm 10.30.2. Start from current `main`, install frozen
dependencies, prepare SQLite when exercising native data commands, and run the gate:

```bash
pnpm install --frozen-lockfile
pnpm setup:sqlite
pnpm precommit
```

Dependency lifecycle scripts stay disabled. Focused package build, typecheck, lint
and unit commands help while iterating. See [AGENTS.md](AGENTS.md) for package
boundaries and the rest of the engineering guidance. Never commit credentials.

Fork PR CI uses a read-only GitHub token and no repository secrets. It runs the
build, security guards, types/lint/docs/format checks, unit and structural tests,
packed-catalog checks, credential-free showcases and an installed-package outsider
suite. GitHub may require maintainer approval before a new contributor's run starts.
The public metadata-only policy job runs in the base context with permission to
label and comment on PRs; it never checks out or executes the submitted code.
The required `pr-metadata` workflow checks Change Type on every PR and DCO sign-offs once the public repository is live.

Select exactly one Change Type in the PR template. A merge into `main`
releases a new version that a maintainer approves before publication. The Change
Type sets the bump: `minor` and `major` release that increment; `dependencies`
does not release on its own and ships with the next release; everything else
releases a patch. A dependency update that also changes behaviour or code picks
`patch`, `minor` or `major`. On a Dependabot PR, a maintainer sets this with one
`change-type: patch`, `change-type: minor` or `change-type: major` label.
`skip-release` is a rare escape hatch for changes that must not publish. A
revert of released code is `patch`; a revert of unreleased code is
`skip-release`. Maintainers can help classify a small fix.
[Release guidance](docs/releases.md) explains releases.

The network dependency audit runs on pull requests that change `package.json`,
`pnpm-lock.yaml` or `pnpm-workspace.yaml`, on main, the weekly schedule and
manual dispatch, and in release artifact checks. Run `pnpm security:audit` when
network access is available. The 7-day dependency release age remains in force, except for owner-approved
exact-version security-fix exemptions listed in `docs/dependency-security.md`. A daily health check
monitors expired exemptions, approaching deadlines, and consumer audit findings; see
the [health check section](docs/dependency-security.md#daily-release-health-check) in
the dependency security guide.

## Commits and pull requests

These apply to everyone, maintainers included.

- **Pull request title:** an imperative sentence of about 72 characters or fewer
  that describes the effect for users, for example "Add an RFC 8707 resource to
  OAuth2 client credentials". Release notes are generated from these titles. No
  `feat:` or `fix:` prefixes; the Change Type records the kind of change.
- **Pull request description:** what changes and why, written so that anyone
  can read it. Fill in the template and select exactly one Change Type.
- **Commits:** one logical change per commit, an imperative subject line, a body
  that explains why, and a DCO sign-off (`git commit -s`).

## AI-assisted contributions

You may use AI tools to prepare a contribution.
Your DCO sign-off certifies that you have the right to submit all contributed material, including AI-assisted output.
Do not submit third-party code or text without the required rights and attribution.
Disclose any upstream material reproduced by a tool.
