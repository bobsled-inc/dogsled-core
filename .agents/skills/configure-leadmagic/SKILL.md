---
name: configure-leadmagic
description: Author extract-intents.yml steps and seed files for LeadMagic email-finding workflows.
exposed: true
triggers:
  - use leadmagic
  - leadmagic email finder
  - find work emails leadmagic
  - configure leadmagic extract
  - leadmagic email enrichment
  - verify work email from domain
  - set up leadmagic workflow
  - leadmagic email search
---

# Configure LeadMagic

Use this skill when a user wants LeadMagic to verify work emails from name and company-domain inputs.

## Workflow

1. Ask whether the user has `first_name`, `last_name`, and `company_domain`.
2. Recommend a v1 seed schema with those exact fields.
3. Generate the `extract-intents.yml` step block for `leadmagic/email_finder`.
4. Warn that LeadMagic only charges on successful matches, so estimates should be treated as upper bounds.
5. Recommend `dogsled extract estimate --plan <name>` before `dogsled extract run --plan <name>`.

## Seed Schema

```text
first_name,last_name,company_domain
```

## Example Plan Snippet

```yaml
plans:
  enrich_outbound:
    description: Find work emails with LeadMagic
    budget:
      max_estimated_credits: 250
      on_exceed: fail
    seeds:
      prospects:
        format: csv
        path: ./seeds/prospects.csv
    steps:
      - id: leadmagic_email_finder
        integration: leadmagic
        resource: email_finder
        seed: prospects
        input:
          first_name: ${{ seed.first_name }}
          last_name: ${{ seed.last_name }}
          company_domain: ${{ seed.company_domain }}
        limits:
          max_input_rows: 250
```
