---
name: configure-findymail
description: Author extract-intents.yml steps and seed files for Findymail
  email-finding workflows.
---

# Configure Findymail

Use this skill when a user wants Findymail to search verified emails from name and domain seeds.

## Workflow

1. Ask whether the user has a full name and company domain for each target.
2. Recommend a seed schema with `name` and `domain`.
3. Generate the `extract-intents.yml` step block for `findymail/email_finder`.
4. Warn that Findymail is pay-per-result, so estimates are upper bounds.
5. Recommend `bobsled extract estimate --plan <name>` before `bobsled extract run --plan <name>`.

## Seed Schema

```text
name,domain
```

## Example Plan Snippet

```yaml
plans:
  enrich_outbound:
    description: Find verified emails with Findymail
    budget:
      max_estimated_credits: 200
      on_exceed: fail
    seeds:
      prospects:
        format: csv
        path: ./seeds/prospects.csv
    steps:
      - id: findymail_email_finder
        integration: findymail
        resource: email_finder
        seed: prospects
        input:
          name: ${{ seed.name }}
          domain: ${{ seed.domain }}
        limits:
          max_input_rows: 200
```
