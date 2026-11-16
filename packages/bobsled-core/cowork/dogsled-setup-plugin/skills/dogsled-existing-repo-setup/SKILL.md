---
name: dogsled-existing-repo-setup
description: Use this skill when the user opens an existing repo and wants Cowork to continue or repair Dogsled setup from local files.
version: 1.0.0
---

# Dogsled Existing Repo Setup

When this skill applies:

- read `AGENTS.md`, `bobsled.setup.answers.yml`, `bobsled.setup.summary.md`, and `bobsled.yml` if present
- run `dogsled setup doctor` to understand the current blockers
- only rerender files with `dogsled setup render` after confirming the intended changes
- prefer repairing the local answers file over inventing a new setup path
