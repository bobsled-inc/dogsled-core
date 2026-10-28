---
name: starter-models-pylon
description: Curated starter analytics models, metrics, and relationships for Pylon support and product feedback. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - pylon starter models
  - prebuilt pylon models
  - curated pylon analytics models
  - standard pylon data models
  - build pylon marts
  - Pylon analytics shape
  - models for pylon
---

# Starter data models — Pylon

Customer support and product feedback models for Pylon issues, feature requests, contacts, and tasks.

These are the **gold marts** for Pylon — the canonical analytics
tables an analyst would build on top of the loaded Pylon extract. Each
mart references a silver staging model named `stg_pylon__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### pylon\_\_contacts

{{include: packages/models/marts/pylon/pylon__contacts.yml}}

### pylon\_\_feature_request_pipeline

{{include: packages/models/marts/pylon/pylon__feature_request_pipeline.yml}}

### pylon\_\_feature_requests

{{include: packages/models/marts/pylon/pylon__feature_requests.yml}}

### pylon\_\_issues

{{include: packages/models/marts/pylon/pylon__issues.yml}}

### pylon\_\_tasks

{{include: packages/models/marts/pylon/pylon__tasks.yml}}

### pylon\_\_ticket_volume_summary

{{include: packages/models/marts/pylon/pylon__ticket_volume_summary.yml}}

## Metrics

{{include: packages/models/marts/pylon/metrics/pylon_issue_count.yml}}
{{include: packages/models/marts/pylon/metrics/pylon_feature_request_count.yml}}
{{include: packages/models/marts/pylon/metrics/pylon_feature_request_evidence_count.yml}}

## Relationships

{{include: packages/models/marts/pylon/relationships/pylon_feature_requests_to_pipeline.yml}}
{{include: packages/models/marts/pylon/relationships/pylon_issues_to_contacts.yml}}
