# Cutting a release

Dogsled publishes `@bobsled-inc/dogsled` with 15 workspace packages embedded in its tarball.
Only `packages/dogsled/package.json` advances its version.

## Every merge releases

The [Release on merge workflow](../.github/workflows/release-on-merge.yml) runs on every push to `main`.
It reads the merged pull request's Change Type through the GitHub API, using trusted scripts from the merge commit on `main`.
It never checks out the pull request head and uses no secrets.
Every merge produces a release; the Change Type sets the bump size:

| Change Type                                                                  | Release                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `major`                                                                      | Major. Under `0.x` this advances the minor; the notes carry a Breaking banner. |
| `minor`                                                                      | Minor                                                                          |
| `patch`, `performance`, `dependencies`, `internal`, `documentation`, `tests` | Patch                                                                          |
| `skip-release`                                                               | None (rare escape hatch)                                                       |

The `AUTO_RELEASE` repository variable controls the trigger:

- `off` or unset: nothing runs.
- `dry-run`: the decision goes to the job summary. Nothing else happens.
- `on`: a merge dispatches the Release workflow in `auto` mode.

In `auto` mode, preparation covers every pull request merged since the last stable release tag and takes the highest increment.
The prepare job summary lists each pull request, its Change Type and the result, so review it before approving publication.
GitHub keeps at most one pending Release run and replaces an older pending run, but the newer run still covers the same merges.
A commit without a merged pull request, or a pull request without exactly one valid Change Type, fails the run.
Fix the description, then run the Release workflow from `main` in `auto` mode.
Fork pull requests get a read-only token, so their merge cannot dispatch a release.
Dispatch `auto` by hand, or let the next release-worthy merge include them.
A revert of released code is `patch`. A revert of unreleased code is `skip-release`.

## Steps

1. Merges dispatch `auto` releases. To release by hand, open the [Release workflow](../.github/workflows/release.yml), select `main` and choose a mode and its inputs below.
2. The prepare job checks and packs the candidate. A run with nothing to release stops here. A Slack notification goes out when a release awaits approval.
3. Review the candidate checks, the artifact report and, for `auto`, the pull request table, then approve the release in `release-approval`. This is the only approval; a rejection leaves no tag.
4. The tag job pushes the verified tag from the `release-tag` environment, which is limited to `main` and needs no approval.
5. Publication runs in `npm-release`. Verify registry integrity, provenance, the GitHub release report and SBOM, and a clean install without credentials.

| Mode      | Inputs                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`     | Choose `bump: patch`, `minor`, or `major`. Under `0.x`, major advances the minor. A `1.0.0` release requires a reviewed manifest transition. |
| `auto`    | None. The increment comes from the pull requests merged since the last stable tag; with every one `skip-release`, nothing is released.       |
| `preview` | Supply a new `0.x.y-preview.N`. The workflow uses npm's `preview` dist-tag and creates a GitHub prerelease.                                  |
| `retry`   | Supply an existing stable or preview version. The tag, manifest, and reviewed candidate must agree.                                          |

After the version decision, four parallel job groups run the same checks as CI without cache:
`release-checks` (build, types, lint, structural), `release-unit` (four test partitions),
`release-packed-catalog` (packed import smoke test) and `release-audit` (tarball, SBOM, consumer audit and tag creation).
A `release-checks-ok` gate waits for all of them before the approval step.
The report records tarball integrity and the CycloneDX software bill of materials (SBOM).
Public releases use npm trusted publishing (OIDC) and require provenance.
A maintainer approves the release in the `release-approval` environment before any tag is pushed.
Tag creation runs in `release-tag` (limited to `main`, no reviewers).
Publication runs in `npm-release`, which npm's trusted publisher is bound to.
The workflow pushes the verified tag with hooks disabled. It does not push release bookkeeping to `main`.

After changing bundled dependencies, build and run `node scripts/release/third-party-notices.mjs`.
Review [THIRD_PARTY_NOTICES.md](../packages/dogsled/THIRD_PARTY_NOTICES.md) before dispatching the release.

Preparation sets npm fetch timeouts and retries, and time limits on the install, packed-catalog and release-verification steps, so a stalled registry connection fails within minutes instead of using up the job.
The packed-catalog check retries once on its own. Before a tag is pushed, re-run the failed prepare job.
Investigate interrupted runs before retrying. Rejecting the approval leaves no tag and no version gap; the next release-worthy merge tries again.
To ship an existing tag whose publication failed, use `retry` mode. An existing registry version must match the reviewed tarball's integrity.
Never replace a version tag or overwrite published bytes.
If only GitHub release finalization fails, re-run the failed jobs: it creates a missing release, uploads only missing attachments and fails if an existing attachment differs from the reviewed file, without overwriting or deleting anything.

When a release awaits approval, two Slack messages appear in the release channel:

1. The workflow posts the version, the merged pull request titles and a Breaking note if any. This message is skipped when `SLACK_RELEASE_WEBHOOK_URL` is unset and never fails the release.
2. The GitHub Slack app posts the deployment approval with Approve and Reject buttons. Set it up with `/github subscribe bobsled-inc/dogsled-core workflows` (filtered to the Release workflow); each maintainer runs `/github signin` once.

A later follow-up could let Husky post YES/NO buttons that call the pending-deployments API, needing a token allowed to approve `release-approval`; that is not implemented here.
