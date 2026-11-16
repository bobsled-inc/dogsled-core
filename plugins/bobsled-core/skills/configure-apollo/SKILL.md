---
name: configure-apollo
description: Author extract-intents.yml steps for Apollo endpoints that consume
  credits, without expanding Apollo endpoint coverage.
---

# Configure Apollo

Use this skill when a user wants to budget Apollo API calls that consume credits.

## Workflow

1. Ask which existing Apollo endpoint they intend to call and what seed fields drive that request.
2. Reuse the current Apollo resource surface; do not invent new endpoints in this skill.
3. Generate the `extract-intents.yml` step block for the chosen billable Apollo resource.
4. Warn that Apollo billing depends on the endpoint and should be confirmed against the workspace pricing plan.
5. Recommend `bobsled extract estimate --plan <name>` before `bobsled extract run --plan <name>`.

## Example Plan Snippet

```yaml
plans:
  apollo_company_search:
    description: Budget Apollo company search calls
    budget:
      max_estimated_credits: 100
      on_exceed: fail
    seeds:
      searches:
        format: yaml
        path: ./seeds/searches.yml
    steps:
      - id: apollo_search_companies
        integration: apollo
        resource: search_companies
        seed: searches
        input: {}
        limits:
          max_input_rows: 100
```
