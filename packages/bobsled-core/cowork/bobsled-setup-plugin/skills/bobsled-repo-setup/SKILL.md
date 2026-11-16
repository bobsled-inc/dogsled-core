---
name: bobsled-repo-setup
description: Use this skill when the user wants Claude Cowork to create a new Dogsled repo from scratch or set up a repo in plain English without manual YAML editing.
version: 1.0.0
---

# Dogsled Repo Setup

Use the local `dogsled setup` commands as the source of truth:

1. `dogsled setup install`
2. `dogsled setup recommend --write`
3. `dogsled setup render`
4. `dogsled setup doctor`
5. `dogsled runner validate --strict` when local configuration is ready

Rules:

- ask one question at a time
- recommend defaults instead of giving a long taxonomy
- store only secret references or placeholders
- leave a concise `bobsled.setup.summary.md` behind in the repo
