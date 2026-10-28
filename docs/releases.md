# Cutting a release

Dogsled publishes `@bobsled-inc/dogsled` with 15 workspace packages embedded in its tarball.
Only `packages/dogsled/package.json` advances its version. Merging a pull request does not publish a package.

1. Open the [Release workflow](../.github/workflows/release.yml) and select `main`.
2. Choose a mode and supply the inputs below.
3. Review the candidate checks and artifact report before approving tag creation in `npm-release`.
4. Approve publication of the reviewed tarball in `npm-release`.
5. Verify registry integrity, provenance, the GitHub release report and SBOM, and a clean install without credentials.

| Mode      | Inputs                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`     | Choose `bump: patch`, `minor`, or `major`. Under `0.x`, major advances the minor. A `1.0.0` release requires a reviewed manifest transition. |
| `preview` | Supply a new `0.x.y-preview.N`. The workflow uses npm's `preview` dist-tag and creates a GitHub prerelease.                                  |
| `retry`   | Supply an existing stable or preview version. The tag, manifest, and reviewed candidate must agree.                                          |

Preparation runs frozen installation, SQLite setup, security, `precommit`, packed-catalog, and release artifact checks.
The report records tarball integrity and the CycloneDX software bill of materials (SBOM).
Public releases use npm trusted publishing (OIDC) and require provenance.
Tag creation and publication each require approval in the protected `npm-release` environment.
The workflow pushes the verified tag with hooks disabled. It does not push release bookkeeping to `main`.

After changing bundled dependencies, build and run `node scripts/release/third-party-notices.mjs`.
Review [THIRD_PARTY_NOTICES.md](../packages/dogsled/THIRD_PARTY_NOTICES.md) before dispatching the release.

Investigate interrupted runs before retrying. Rejected publication approval can leave an approved tag without a package.
Retry the same candidate after review. An existing registry version must match the reviewed tarball's integrity.
Never replace a version tag or overwrite published bytes.
If only GitHub release finalization fails, re-run the failed jobs: it creates a missing release, uploads only missing attachments and fails if an existing attachment differs from the reviewed file, without overwriting or deleting anything.
