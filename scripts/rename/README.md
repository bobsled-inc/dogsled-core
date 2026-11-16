# Rename tooling (Dogsled Core -> Bobsled Core)

Lives on `rename/bobsled-core` only and is left out of the final export.

- `mapping.mjs`: the reviewed name map. Rules `BC-01`..`BC-22`, the keep list, `COMPAT_PATHS`, items left to design PRs.
- `sync-main.mjs`: catches the branch up with main through a mirror of renamed main (below).
- `rename.mjs`: applies the map. Dry run by default; `--apply --rules <ids|BC-xx>` for one step-5 PR; `--apply --all` to rename a whole tree; `--check` lists what is left; `--patch` translates a single diff; `--only <glob,...>` limits any mode to some files.

What the tool never rewrites:

- **Compatibility readers.** The contents of files in `COMPAT_PATHS` (`**/legacy-names.ts`, their `legacy-names*.test.ts` tests, `examples/old-formats/fixtures/**`) keep the old names that stored data still uses. These files still move with their folder (`packages/dogsled/src/legacy-names.ts` becomes `packages/bobsled-core/src/legacy-names.ts`); only `NO_MOVE_PATHS` (old-format fixtures) keep their path. Put each package's old names in its `legacy-names.ts`. Mark any other deliberate old name, for example in `examples/old-formats/showcase.mjs`, with a `rename:keep` comment on the same line.
- Keep-list names that contain "dogsled" (masked before any rule runs).
- This tool and the old-name guard.

Every rule matches only old spellings, so a replay changes nothing that is already renamed. That holds **except** for files in `COMPAT_PATHS` and `rename:keep` lines, which the tool never touches. Old names that are still outside them (see "Existing readers" in `HANDLED_BY_DESIGN`) are rewritten by the first apply of their category, so move them first.

`--check` reporting 0 means no rule matches any more. It does not mean no old name is left: the old-name guard (`pnpm guard:rename`) is the authority on that.

`--apply` also moves the paths in the old-name guard's allow list (`scripts/guards/old-names-allow.json`) with the files they point at, so exceptions do not go stale when a folder moves.

`--rules` runs only some rules. The unselected rules still run in order but only mask their matches, so a subset run gives the same text as the full run limited to the selected rules (for example `--rules BC-04` leaves `@bobsled-inc/dogsled` for BC-01).

## Catch up with main

Do this after every main release, at least weekly, and always right before a preview or the export.

`sync-main.mjs` first works out how far the branch is renamed. It counts what each rename category still matches on the branch and in the main commit the branch last merged:

- **Not renamed yet** (no category applied; design PRs with compatibility readers may already be on the branch): a plain merge of main. Nothing is renamed.
- **Fully renamed** (every category that matches in main matches nothing on the branch): the branch merges a **mirror of renamed main**. The mirror is a chain of commits whose trees are main after the full rename, built with `git commit-tree` (parents: previous mirror, main). Each sync's merge base is therefore the previously synced renamed main, so only main's real changes come in, and design-PR edits (for example a reader moved into `legacy-names.ts`) never conflict with the rename. The first fully renamed sync seeds the mirror from the last merged main, renamed, and records it with `git merge -s ours`, which changes no files.
- **Partly renamed**: refused. The mechanical rename PRs (the `--rules` category PRs) land back to back, with no main sync between them. Sync right before the first one and right after the last one.

Known limit: a category counts as applied once it matches nothing on the branch. If a design PR moves the last few occurrences of a small category (BC-18, BC-19 and BC-22 have only a handful) into `legacy-names.ts` or `rename:keep` lines, an unrenamed branch reads as partly renamed and syncs are refused. That fails safe; if it happens, record the applied categories explicitly or add an override, rather than forcing the sync.

Steps:

1. `git fetch origin && git switch -c sync/main-<short-sha> origin/rename/bobsled-core`
2. `node scripts/rename/sync-main.mjs` (defaults: `--main origin/main --mirror sync/main-renamed`). In mirror mode it renames main in a throwaway worktree with this branch's script, points the local `sync/main-renamed` branch at the new mirror commit and merges it. If that branch is missing locally and on origin, pass the last mirror SHA from the previous sync PR with `--mirror-sha`.
3. Conflicts mean main and the branch changed the same lines for real. For each file, compare with **main's own diff**, `git diff <previous synced main> origin/main -- <path>`, and apply only that change (renamed, in mirror mode). Never take main's whole side: that can undo a design-PR edit.
4. Do **not** run `--apply` on the merged tree. In mirror mode, `node scripts/rename/rename.mjs --check` must report 0 matches.
5. `pnpm install` (lockfile), then regenerate the skill catalogue and plugin output with `pnpm --filter @bobsled-inc/skills generate:manifest` and confirm with `pnpm skills:check`. Regenerate `packages/integrations` generated data the same way if main changed integrations.
6. `pnpm guard:rename` must not show new findings or stale exceptions; run `pnpm build`, `pnpm check` and the tests as usual.
7. Open a PR into `rename/bobsled-core` titled `Sync main <sha>` (with the mirror SHA in the body in mirror mode). Merge it with a **merge commit** (not squash). After it merges, push the mirror: `git push origin sync/main-renamed`.

Fallback when a sync is too messy: replay main's commits one by one. `--patch` renames diff lines after their ` `, `+` or `-` marker, moves compatibility files with their folder and leaves their lines untouched.

```sh
git format-patch <last-synced-main-sha>..origin/main -o /tmp/main-patches
for p in /tmp/main-patches/*.patch; do
  node scripts/rename/rename.mjs --patch "$p" --out "$p.renamed" && git am "$p.renamed" || break
done
```

`git am -3` cannot fall back to a 3-way merge here (the blob ids in the patch no longer exist), so fix a failed patch by hand. After a fallback, run `sync-main.mjs` at the next sync as usual; it brings the mirror up to date.
