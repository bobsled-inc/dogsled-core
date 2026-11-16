---
name: bobsled-repo-setup
description: Use this skill when the user wants Claude Cowork to create a new Bobsled Core repo from scratch or set up a repo in plain English without manual YAML editing.
version: 1.0.0
---

# Bobsled Core Repo Setup

Use the local `bobsled setup` commands as the source of truth:

1. `bobsled setup install`
2. `bobsled setup recommend --write`
3. `bobsled setup render`
4. `bobsled setup doctor`
5. `bobsled runner validate --strict` when local configuration is ready

Rules:

- ask one question at a time
- recommend defaults instead of giving a long taxonomy
- store only secret references or placeholders
- leave a concise `bobsled.setup.summary.md` behind in the repo
