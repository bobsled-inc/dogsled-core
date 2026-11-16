# Dependency playbooks

Each playbook says how to reproduce the problem, what to change, how to prove
the fix, and what the PR should contain. Start every one from updated `main` on
a new branch, then run `pnpm install --frozen-lockfile`.

The daily health check reports exactly four kinds, built in
`scripts/deps/health-findings.mjs`: `expired_exemption`, `deadline_soon`,
`stale_parent` and `new_finding`. The other playbooks cover problems that show
up in CI or Dependabot PRs instead.

## Expired exemption (`expired_exemption`)

Meaning: a `minimumReleaseAgeExclude` version is past its removal date plus the
3-day grace. It is now old enough, so the exemption is no longer needed. The
finding names `package` and `version`.

1. Reproduce: `pnpm deps:expiries` shows the entry as `EXPIRED`;
   `pnpm test:structural` fails on it.
2. Confirm the version has met the release age:
   `npm view <package> time --json --registry=https://registry.npmjs.org/` and
   check that `<version>` is more than 7 days old.
3. Remove the exact `<package>@<version>` line from `minimumReleaseAgeExclude`
   in `pnpm-workspace.yaml` (leave `[]` when it was the last one).
4. Remove its row from the exemptions table in `docs/dependency-security.md` and
   update the sentence under the table. Keep any `overrides` entry that pins the
   same version: it pins the fix, not the exemption.
5. Prove it: `pnpm install --frozen-lockfile` (the lockfile must not change),
   `pnpm deps:expiries`, `pnpm security:audit`, `pnpm test:structural`,
   `pnpm check`.
6. PR: Change Type `internal`. Evidence: publish time and age, and the command
   results above.

## Deadline soon (`deadline_soon`)

Meaning: one of these is due within 7 days, or is overdue:

- a release-age exemption inside its 3-day grace (`file: pnpm-workspace.yaml`);
- an `audit-ci.json` allowlist expiry (`file: audit-ci.json`);
- a consumer-exception review deadline
  (`file: scripts/security/consumer-exceptions.json`).

Automation may prepare a draft repair, but a maintainer decides whether any
deadline or policy change is valid. Run `pnpm deps:expiries` to see every date.

- **Exemption in grace:** follow "Expired exemption" now. The cleanup is safe as
  soon as the version is 7 days old.
- **audit-ci allowlist or consumer exception:** first check whether the entry is
  still needed. Upgrade or remove the vulnerable dependency if an age-eligible
  fixed version exists ("New advisory", option 1), then delete the entry and
  the matching text in `docs/dependency-security.md`. Rerun the consumer audit
  to prove it.
- **Renewal:** only when it is still needed. Re-review the current reachable
  code path (as in "Stale parent", step 3), then move `expiry` and the "Review
  by" date in `docs/dependency-security.md` together. Keep renewals short
  (weeks). The PR must say what was re-reviewed. Never renew without that
  review.

Overdue consumer exceptions stop matching: their findings become `unhandled`
and fail the release audit.

## Stale parent (`stale_parent`)

Meaning: the consumer audit found an advisory that an exception covers, but the
tree now pulls it in through a parent version the exception has not reviewed.
This usually happens when an optional driver publishes a new version and it
ages into the `latest` consumer tree. The finding names `parentPackage`,
`parentVersion` and `reviewedParentVersions`.

1. Reproduce. Run `pnpm build && pnpm run setup:sqlite`, then
   `node scripts/deps/consumer-check.mjs --output /tmp/health-check --lookahead-days 3`
   and `node scripts/deps/health-check.mjs --output /tmp/health-check`. Read
   `/tmp/health-check/consumer-findings.json`: `isLookahead: false` means the
   release audit already fails; `true` means it will fail within 3 days.
2. Find why the version is selected. Driver ranges are the optional
   `peerDependencies` in `packages/*/package.json`. The consumer audit picks the
   newest version that satisfies every range and is older than the cutoff. A
   range without an upper bound, such as `>=2.0.0`, also admits new majors.
   Get the publish time with
   `npm view <parentPackage> time --json --registry=https://registry.npmjs.org/`.
3. Review the published tarball against the newest reviewed version. Work in an
   empty scratch directory and never run code from it:

   ```bash
   npm pack <parentPackage>@<reviewed> --pack-destination old --registry=https://registry.npmjs.org/
   npm pack <parentPackage>@<parentVersion> --pack-destination new --registry=https://registry.npmjs.org/
   tar -xzf old/*.tgz -C old && tar -xzf new/*.tgz -C new
   diff -rq old/package new/package
   ```

   Check the files the exception's `reason` depends on (for example the code
   that decides whether the vulnerable dependency is ever used), the dependency
   ranges, `engines`, module format and exports, public APIs, and any new install
   scripts or native binaries
   (`npm view <parentPackage>@<parentVersion> scripts dependencies engines --json`).

4. Decide:
   - **(a) Add the version.** Only if the reason still holds in the new
     tarball and the new parent remains inside Bobsled Core's supported Node,
     module, platform and API contracts. Add `parentVersion` to `parentVersions` in
     `scripts/security/consumer-exceptions.json` and to the version list in the
     matching "Reviewed exceptions" paragraph of `docs/dependency-security.md`.
     Do not change `expiry`, `path` or `versions`.
   - **(b) Cap the range.** If the new version changes the reasoning, cannot be
     reviewed, or falls outside any supported runtime or compatibility contract,
     add an upper bound to the optional peer range in every `packages/*/package.json`
     that declares it (for example `>=2.0.0 <3`), and note the cap in
     `docs/dependency-security.md`. A maintainer then decides whether to support
     the new version.
5. Prove it: rerun step 1 and confirm no findings at both cutoffs; run the
   adapter regression tests the exception names, `pnpm test:structural` and
   `pnpm check`. To prove a version that has not aged in yet, raise
   `--lookahead-days` until its publish time plus 7 days falls inside the
   cutoff.
6. PR: Change Type `internal` for (a). For (b), `patch` if the cap changes what
   users can install or run, otherwise `internal`. Evidence: publish time and
   age-eligible time, the files compared and what changed, why the reason still
   holds (or why it does not), and the consumer audit results.

Worked example: `@databricks/sql` 3.0.0 entered the `latest` tree because both
peer ranges were `>=2.0.0`. Its proxy path was unchanged, but its `engines`
allowed only selected Node 22, 24 and 26 patch lines while Bobsled Core supported
every Node version from 24 onward. So the fix was (b): cap both optional peer
ranges at `>=2.0.0 <3` and keep the reviewed exception on 2.x.

## New advisory (`new_finding`)

Meaning: a high or critical advisory with no matching exception. The finding
names `advisory`, `package`, `version` and `severity`. Automation may prepare a
draft repair, but a maintainer decides; an exception needs owner approval.

1. Reproduce with the consumer audit (see "Stale parent", step 1) and find the
   paths in `/tmp/health-check/consumer-current/<floor|latest>/`. For the
   workspace lockfile, run `pnpm security:audit` and
   `pnpm why -r <package>`.
2. Read the advisory (affected function, fixed versions). Do not discuss an
   undisclosed issue in public.
3. Fix, in this order of preference:
   1. **Upgrade to an age-eligible fixed version.** For the workspace, use the
      catalog or a direct dependency, or an `overrides` entry for a transitive
      one (see "Override bump"). Overrides never reach users, so a consumer
      path needs a fix in a published dependency range: a new version of the
      parent, or a higher driver minimum in the peer ranges, the runtime checks
      and the "Driver security minimums" table.
   2. **Fixed version younger than 7 days.** Wait for it to age in. If the
      risk is urgent, the owner may approve an exact-version exemption after
      checking the publisher, `npm audit signatures` in a scratch install,
      provenance where published, no install scripts, and a diff that matches
      the release notes. Add `name@version` to `minimumReleaseAgeExclude` and a
      table row with the removal date (publish time + 7 days).
   3. **No fix, or unreachable code.** Write an exception only with owner
      approval: exact advisory, package version and path, `parentVersions`,
      owner, `status` (`not_applicable` or `accepted_risk`), a short `expiry`,
      and a `reason` naming the code path and its regression test. Add the
      matching paragraph to "Reviewed exceptions". If the lockfile is affected
      too, add the matching `audit-ci.json` allowlist entry with an `expiry`.
4. Prove it: the consumer audit and `pnpm security:audit` pass,
   `pnpm deps:expiries` lists any new dates, `pnpm test:structural`,
   `pnpm check`.
5. PR: `dependencies` for an upgrade or override, `internal` for an exception
   or exemption only.

## Reviewing a Dependabot PR

Grouped minor and patch PRs can still break Bobsled Core. Read the changed versions
in the lockfile diff and each package's release notes, and look closely at:

- a Node `engines` floor above the supported range, or holes that exclude a Node
  version Bobsled Core supports, in `.nvmrc` and the package `engines` fields;
- ESM or CommonJS changes, new `exports` maps or removed entry points;
- new, removed or narrower `peerDependencies`, or dependencies that become
  peers;
- removed or renamed APIs that Bobsled Core imports (search with `git grep`);
- new native binaries, `preinstall`, `install` or `postinstall` scripts
  (`npm view <name>@<version> scripts --json`);
- licence changes, which also change the third-party notices;
- packages bundled into the published build, which change
  `packages/bobsled-core/THIRD_PARTY_NOTICES.md`;
- the security pins: an update that conflicts with an `overrides` entry fails
  the install or build (see "Override bump").

Leave risky updates for a maintainer and say why in a review comment. A
failing check you can fix (notices, an override) gets its own small change.
Dependabot PRs count as `dependencies` and wait for the next release. When an
update changes behaviour or must ship now (a security fix), add exactly one
`change-type: patch`, `change-type: minor` or `change-type: major` label.

## Stale third-party notices

Meaning: CI fails at `node scripts/release/third-party-notices.mjs --check`
because a bundled package version changed.

1. Check out the PR branch, then run `pnpm install --frozen-lockfile`,
   `pnpm build` and `node scripts/release/third-party-notices.mjs`. Review
   the diff of `packages/bobsled-core/THIRD_PARTY_NOTICES.md`: only the changed
   packages should move.
2. If generation fails:
   - `No license text for <id>`: the package ships no licence file. Confirm
     the licence at a pinned upstream commit and add a `COPYRIGHT_FALLBACKS`
     entry in `scripts/release/third-party-notices.mjs` with the same licence,
     copyright and source link. Remove the entry for the old version once it
     is no longer bundled.
   - `Unreviewed per-file license marker: <id>/<file>` or
     `Stale reviewed package supplement: <id>`: update the entry in
     `scripts/release/embedded-notices.json`. Rename the key to the new
     version, read the marked files' licence headers, and set each hash to
     `shasum -a 256 node_modules/.pnpm/<name>@<version>*/node_modules/<name>/<file>`.
   - `Fallback license declaration changed`: the upstream licence changed.
     Stop; a maintainer reviews it.
3. Prove it: `node scripts/release/third-party-notices.mjs --check`,
   `pnpm check`.
4. Commit with `git commit -s` on the Dependabot branch. Dependabot stops
   rebasing a branch once someone else commits to it, so do this last. If a
   prerequisite is valid on `main` on its own (an override or a fallback
   entry), land it as a separate PR first.

## Override bump

Meaning: an `overrides` entry pins a security fix, but an update needs a newer
version of the same package (for example, a new export) and the build fails.

1. Reproduce on the failing branch: `pnpm install` and `pnpm build`.
2. Find the lowest age-eligible version that has both the security fix in the
   override's comment and what the update needs (check publish times with
   `npm view <name> time --json --registry=https://registry.npmjs.org/`).
   Check it has no install scripts.
3. Raise only that override in `pnpm-workspace.yaml` and keep its comment
   accurate. Run `pnpm install` to update the lockfile.
4. If the package is bundled, regenerate the notices ("Stale third-party
   notices"), including any `embedded-notices.json` or fallback entries.
5. Prove it: `pnpm install --frozen-lockfile`, `pnpm build`,
   `pnpm security:audit`, `node scripts/release/third-party-notices.mjs --check`,
   `pnpm test:structural`, `pnpm check`. Then apply the blocked update on top
   and show that install and build pass.
6. PR: Change Type `dependencies`. Say which update it unblocks and why the
   override is still needed. Delete an override, and its comment, only when
   every dependent already requires a fixed version.
