---
name: configure-exa
description: Author extract-intents.yml steps and seed files for Exa search workflows.
exposed: true
triggers:
  - use exa
  - exa web search
  - configure exa search
  - budget exa calls
  - exa research queries
  - set up exa extract
  - run web search via exa
  - exa search enrichment
---

# Configure Exa

Use this skill when a user wants Exa web search calls to be budgeted and explicitly reviewed before execution.

## Workflow

1. Ask for the research query and desired result count.
2. Recommend a seed schema with `query` and optionally `num_results`.
3. Generate the `extract-intents.yml` step block for `exa/search`.
4. Warn that Exa pricing varies by search mode and returned content depth; estimates should be treated as upper bounds.
5. Recommend `dogsled extract estimate --plan <name>` before `dogsled extract run --plan <name>`.

## Seed Schema

```text
query,num_results
```

## Example Plan Snippet

```yaml
plans:
  exa_company_research:
    description: Run Exa searches against account briefs
    budget:
      max_estimated_credits: 50
      on_exceed: fail
    seeds:
      searches:
        format: csv
        path: ./seeds/searches.csv
    steps:
      - id: exa_search
        integration: exa
        resource: search
        seed: searches
        input:
          query: ${{ seed.query }}
          num_results: ${{ seed.num_results }}
        limits:
          max_input_rows: 25
```
