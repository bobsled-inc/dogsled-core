---
name: configure-datagma
description: Author extract-intents.yml steps and seed files for Datagma Find
  People workflows.
---

# Configure Datagma

Use this skill when a user wants Datagma to find people by company and job title.

## Workflow

1. Ask for the company identifier and the job title or function they want Datagma to search.
2. Recommend a v1 seed schema with `company` and `title`.
3. Generate the `extract-intents.yml` step block for `datagma/find_people`.
4. Warn that Datagma Find People has variable billing: successful searches cost more than no-result searches, so estimates are upper bounds.
5. Recommend `bobsled extract estimate --plan <name>` before `bobsled extract run --plan <name>`.

## Seed Schema

```text
company,title
```

## Example Plan Snippet

```yaml
plans:
  find_buying_committee:
    description: Find target personas inside named accounts
    budget:
      max_estimated_credits: 100
      on_exceed: fail
    seeds:
      accounts:
        format: csv
        path: ./seeds/accounts.csv
    steps:
      - id: datagma_find_people
        integration: datagma
        resource: find_people
        seed: accounts
        input:
          company: ${{ seed.company }}
          title: ${{ seed.title }}
        limits:
          max_input_rows: 10
```
