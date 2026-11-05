---
name: dogsled-publish-skill
description: Update the bundled Skill manifest after changing a Skill, catalog, or transcluded document.
---

# Update bundled Skills

Dogsled bundles `.agents/skills/<name>/SKILL.md` files whose front matter contains
`exposed: true`. Skills without that field are contributor guidance and are not
included in the runtime manifest. Users install `@bobsled-inc/dogsled`. The Skills
workspace is embedded in that package.

1. Edit the Skill, catalog, or canonical document.
2. Run `pnpm --filter @bobsled-inc/skills generate:manifest`.
3. Run `pnpm skills:check`, `pnpm --filter @bobsled-inc/skills test:unit`, and `pnpm docs:ci`.
4. Commit the source, `packages/skills/src/generated-data.ts`, and generated plugin
   files together. The command also refreshes `plugins/dogsled-core/` and the Claude and
   Codex marketplace catalogs.

For a new exposed Skill, add `name`, `description`, `exposed: true`, and `triggers`
to its front matter. Choose trigger phrases that describe the supported task.
Catalog values in `packages/skills/content/catalogs/` and exposed Skill names are
append-only contracts. Coordinate a deprecation before removing or renaming them.

Use transclusion to reuse canonical documentation. Paths are relative to the
repository root and case-sensitive:

```markdown
{{include: packages/model-spec/docs/materializations-reference.md}}
{{include-section: packages/model-spec/README.md#Quick Start}}
```

The manifest generator validates containment, bounds include depth, and embeds
the content. `packages/skills/tests/generated-data.test.ts` checks for drift.
