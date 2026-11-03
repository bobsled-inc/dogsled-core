---
name: configure-hunter
description: Author extract-intents.yml steps and seed files for Hunter Email
  Finder workflows.
---

# Configure Hunter

Use this skill when a user wants Hunter to derive professional email addresses from names and company domains.

## Workflow

1. Ask whether the user has names plus company domains; Hunter Email Finder is strongest with that shape.
2. Recommend a seed schema with `first_name`, `last_name`, and `company_domain`.
3. Generate or update the `extract-intents.yml` step block for `hunter/email_finder`.
4. Warn that Hunter Email Finder is billed per request.
5. Recommend `dogsled extract estimate --plan <name>` before `dogsled extract run --plan <name>`.

## Seed Schema

```text
first_name,last_name,company_domain
```

## Example Plan Snippet

```yaml
plans:
  enrich_outbound:
    description: Find work emails with Hunter
    budget:
      max_estimated_credits: 300
      on_exceed: fail
    seeds:
      prospects:
        format: csv
        path: ./seeds/prospects.csv
    steps:
      - id: hunter_email_finder
        integration: hunter
        resource: email_finder
        seed: prospects
        input:
          first_name: ${{ seed.first_name }}
          last_name: ${{ seed.last_name }}
          domain: ${{ seed.company_domain }}
        limits:
          max_input_rows: 300
```
