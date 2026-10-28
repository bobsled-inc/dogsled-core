---
name: pr-template
description: Draft a concise public PR description using the repository template and verified diff.
---

# Pull Request Description

Read `.github/pull_request_template.md`, the diff against current `origin/main`,
and the branch commits. Describe the concrete problem, resulting behavior,
compatibility impact, and checks actually run. The toolkit has one shipped
package embedding 15 internal workspace packages; use
`scripts/release/package-set.mjs` for the authoritative package set.

Select exactly one Change Type using the template's exact checkbox format.
For internal tooling work use:

```markdown
- [x] `internal` - 🏠 Internal
```

Change types classify impact. They do not automatically publish packages or
create releases. Write concise public release notes, or `None` for an internal
change. Include only public context; omit private identifiers, customer or
employee identities, credentials, and private links.

Write the requested description to a temporary file and use `gh pr create
--draft --body-file <path>` only when the task asks to ship. Never enable
auto-merge or dismiss reviews.
