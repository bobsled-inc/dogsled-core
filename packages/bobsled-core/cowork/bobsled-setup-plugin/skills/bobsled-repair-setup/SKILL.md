---
name: bobsled-repair-setup
description: Use this skill when Dogsled setup failed, required files drifted, or the repo needs a plain-English repair path for Cowork.
version: 1.0.0
---

# Dogsled Repair Setup

Repair flow:

1. Run `dogsled setup doctor`
2. Read the blocking checks and missing items
3. Fix the answers file or destination placeholders
4. Rerun `dogsled setup render` if config or docs are stale
5. Validate local pipelines with `dogsled runner validate --strict` if needed
6. Use `dogsled runner validate --strict` before an authorized local run
