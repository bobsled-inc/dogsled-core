# Rename tooling (Dogsled Core -> Bobsled Core)

Lives on `rename/bobsled-core` only and is left out of the final export.

- `mapping.mjs`: the reviewed name map. Rules `BC-01`..`BC-22`, the keep list, `COMPAT_PATHS`, items left to design PRs.
- `rename.mjs`: applies the map. Dry run by default; `--apply --rules <ids|BC-xx>` for one step-5 PR; `--apply --all` to rename a whole tree; `--check` lists what is left; `--patch` translates a single diff; `--only <glob,...>` limits any mode to some files.

What the tool never rewrites:

- **Compatibility readers.** Files in `COMPAT_PATHS` (`**/legacy-names.ts`, their `legacy-names*.test.ts` tests, `examples/old-formats/**`) keep the old names that stored data still uses. Put each package's old names there. Mark any other deliberate old name with a `rename:keep` comment on the same line.
- Keep-list names that contain "dogsled" (masked before any rule runs).
- This tool and the old-name guard.

Every rule matches only old spellings, so a replay changes nothing that is already renamed. That holds **except** for files in `COMPAT_PATHS` and `rename:keep` lines, which the tool never touches. Old names that are still outside them (see "Existing readers" in `HANDLED_BY_DESIGN`) are rewritten by the first apply of their category, so move them first.

`--rules` runs only some rules. The unselected rules still run in order but only mask their matches, so a subset run gives the same text as the full run limited to the selected rules (for example `--rules BC-04` leaves `@bobsled-inc/dogsled` for BC-01).

## Catch up with main

Do this after every main release, at least weekly, and always right before a preview or the export. Rename main first, then merge, so both sides carry the same rename edits and only real changes can conflict.

1. Rename main in a worktree with the branch's script:
   ```sh
   git fetch origin
   git worktree add --detach /tmp/main-renamed origin/main
   node scripts/rename/rename.mjs --apply --all --root /tmp/main-renamed
   git -C /tmp/main-renamed add -A
   git -C /tmp/main-renamed commit -m "Rename main $(git rev-parse --short origin/main)"
   ```
2. Merge that commit on a sync branch:
   ```sh
   git switch -c sync/main-<short-sha> origin/rename/bobsled-core
   git -c merge.directoryRenames=true merge --no-ff <renamed-commit>
   ```
   Identical rename edits merge cleanly. A conflict means a real overlap, for example main changed a reader that a design PR moved. Resolve it by hand: take main's change, then rename only that file with `node scripts/rename/rename.mjs --apply --all --only <path>`. Never "keep the branch side" wholesale, which drops main's change.
3. Do **not** run `--apply` on the merged tree. Run `node scripts/rename/rename.mjs --check`: it must report 0 matches outside the compatibility readers.
4. `pnpm install` (lockfile), then regenerate the skill catalogue and plugin output with `pnpm --filter @bobsled-inc/skills generate:manifest` and confirm with `pnpm skills:check`. Regenerate `packages/integrations` generated data the same way if main changed integrations.
5. `node scripts/guards/old-names.mjs` must not show new findings or stale exceptions; run `pnpm build`, `pnpm check` and the tests as usual.
6. Open a PR into `rename/bobsled-core` titled `Sync main <sha>`. Merge it with a **merge commit** (not squash) so the next sync finds the common base. Remove the worktree: `git worktree remove /tmp/main-renamed`.

Fallback when a merge is too messy: replay main's commits one by one. `--patch` renames diff lines after their ` `, `+` or `-` marker, and leaves compatibility files untouched.

```sh
git format-patch <last-synced-main-sha>..origin/main -o /tmp/main-patches
for p in /tmp/main-patches/*.patch; do
  node scripts/rename/rename.mjs --patch "$p" --out "$p.renamed" && git am "$p.renamed" || break
done
```

`git am -3` cannot fall back to a 3-way merge here (the blob ids in the patch no longer exist), so fix a failed patch by hand or use the rename-main-first route above.
