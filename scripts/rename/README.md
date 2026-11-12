# Rename tooling (Dogsled Core -> Bobsled Core)

Lives on `rename/bobsled-core` only and is left out of the final export.

- `mapping.mjs`: the reviewed name map. Rules `BC-01`..`BC-22`, the keep list, items left to design PRs.
- `rename.mjs`: applies the map. Dry run by default; `--apply --rules <ids|BC-xx>` for one step-5 PR; `--apply --all` to replay everything; `--check` lists what is left; `--patch` translates a single diff.

Every rule matches only old spellings, so a replay changes nothing that is already renamed. Keep-list names that contain "dogsled" are masked before any rule runs.

## Catch up with main

Do this after every main release, at least weekly, and always right before a preview or the export.

1. `git fetch origin && git switch -c sync/main-<short-sha> origin/rename/bobsled-core`
2. `git -c merge.directoryRenames=true merge --no-ff origin/main`
   Directory rename detection moves files that main added under old folders (for example `packages/dogsled/...`) into the renamed ones. Resolve any conflicts by keeping the branch's spelling.
3. `node scripts/rename/rename.mjs --apply --all`
   This renames whatever main brought in. If it reports "target already exists", merge those files by hand.
4. `pnpm install` (lockfile), then regenerate the skill catalogue and plugin output with `pnpm --filter @bobsled-inc/skills generate:manifest` and confirm with `pnpm skills:check`. Regenerate `packages/integrations` generated data the same way if main changed integrations.
5. `node scripts/guards/old-names.mjs` must not show new findings; run `pnpm build`, `pnpm check` and the tests as usual.
6. Commit, then open a PR into `rename/bobsled-core` titled `Sync main <sha>`. Merge it with a **merge commit** (not squash) so the next merge finds the common base.

Fallback when a merge is too messy: replay main's commits one by one.

```sh
git format-patch <last-synced-main-sha>..origin/main -o /tmp/main-patches
for p in /tmp/main-patches/*.patch; do
  node scripts/rename/rename.mjs --patch "$p" --out "$p.renamed" && git am -3 "$p.renamed" || break
done
```
