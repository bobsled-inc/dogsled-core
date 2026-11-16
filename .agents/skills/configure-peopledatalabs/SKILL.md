---
name: configure-peopledatalabs
description: Author extract-intents.yml steps and seed files for People Data Labs person enrichment workflows.
exposed: true
triggers:
  - use people data labs
  - pdl person enrichment
  - enrich linkedin profiles
  - configure pdl extract
  - people data labs enrichment
  - enrich contacts via pdl
  - set up peopledatalabs workflow
  - pdl person search
---

# Configure People Data Labs

Use this skill when a user wants to buy People Data Labs enrichment against a checked-in seed file.

## Workflow

1. Ask what enrichment input they have in People Data Labs terms: LinkedIn URL, email, or name plus company.
2. Recommend a v1 seed schema. Prefer `linkedin_url` for `person_enrich`.
3. Generate or update the `extract-intents.yml` step block.
4. Warn that PDL is match-billed and estimates are upper bounds when a provider only charges on successful matches.
5. Recommend `bobsled extract estimate --plan <name>` before `bobsled extract run --plan <name>`.

## Seed Schema

Preferred CSV/YAML/JSONL fields:

```text
linkedin_url
```

## Example Plan Snippet

```yaml
plans:
  enrich_candidates:
    description: Enrich recruiting targets with People Data Labs
    budget:
      max_estimated_credits: 200
      on_exceed: fail
    seeds:
      candidates:
        format: csv
        path: ./seeds/candidates.csv
    steps:
      - id: peopledatalabs_person_enrich
        integration: peopledatalabs
        resource: person_enrich
        seed: candidates
        input:
          profile: ${{ seed.linkedin_url }}
        limits:
          max_input_rows: 200
```
