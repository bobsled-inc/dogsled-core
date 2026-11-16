# Agent Skills

`.agents/skills/` is Bobsled Core's only authored skill source. Each skill lives at
`.agents/skills/<name>/SKILL.md` with YAML frontmatter and agent-agnostic Markdown
instructions.

Claude Code discovers the same files through the `.claude/skills` compatibility
symlink. Do not place independent content under `.claude/`.

## Finding The Right Context

Run the repository context command before substantial work:

```bash
pnpm agent:context
pnpm agent:context --json
pnpm agent:context --yaml
pnpm agent:context --staged
pnpm agent:context --base main
pnpm agent:context --paths packages/extractor/src/runtime/http-client.ts
```

It reports the guides, skills, risk surfaces, and focused checks relevant to the
current diff or supplied paths. Agents can also scan the skill frontmatter directly
when the task is not yet represented by a file change. Use pnpm's `--silent` option
when redirecting JSON or YAML so the package-manager banner is not included.

## Authoring

- Keep the main `SKILL.md` focused on triggers, decisions, workflow, and completion.
- Put long schemas, examples, command references, and troubleshooting material in
  adjacent `references/` files and load only what the task requires.
- Keep instructions portable. Avoid model-specific tool names and permission syntax.
- Use `{{include: <repo-relative path>}}` or
  `{{include-section: <path>#<heading>}}` only when the bundled Bobsled Core Skill
  manifest must flatten a reference for downstream consumers.
- Mark downstream skills with `exposed: true` and include useful `triggers`.
- Preserve security and approval boundaries even when shortening prose.

After changing an exposed skill, regenerate and test the manifest:

```bash
pnpm --filter @bobsled-inc/skills generate:manifest
pnpm --filter @bobsled-inc/skills test:unit
```
