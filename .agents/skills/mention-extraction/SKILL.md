---
name: mention-extraction
description: Configure, run, review, and debug document mention extraction.
---

# Mention Extraction

Use this skill when work involves `__document_mentions`, mention review queues, chunker-config migrations, candidate retrieval, prompt-injection safeguards, or `compromise_ner` fallback behavior.

## References

- `docs/reference/advanced/mention-extraction.md`
- `packages/entity-graph/src/runtime/mention/`
- `packages/entity-graph/src/runtime/candidate-retrieval/`
- `packages/entity-graph/src/commands/mentions-review-export.ts`

## Checklist

1. Confirm document ingestion emits `<resource>__chunks`.
1. Confirm entity profiles exist and are fresh:

```bash
bobsled entity-graph resolve profile <entity...> --runner ./runner.js --json
```

1. Validate AI model and budget roles:

```bash
bobsled doctor --json
bobsled ai test --connection mention_disambiguation_v1 --json
```

1. Export review rows:

```bash
bobsled entity-graph mentions review export --runner ./runner.js --schema entity_graph --json
```

1. Inspect a row or chunk before changing resolution logic:

```bash
bobsled entity-graph mentions inspect --runner ./runner.js --schema entity_graph --chunk-id <chunk_id> --include-chunk --json
bobsled entity-graph mentions inspect --runner ./runner.js --schema entity_graph --mention-id <mention_id> --yaml
```

1. If the chunker changed, run or enqueue `mention_resolution` and then re-export review rows.

## Debug Rules

- If rows are `unresolved`, inspect candidate retrieval first. The LLM can only choose IDs returned by the candidate set.
- Use `mentions inspect` to verify the original chunk text, mention span, `resolution_method`, resolved profile, source URI, and same-chunk relationship evidence before editing specs or prompts.
- If rows are `schema_violation`, inspect the raw model response and prompt-injection markers in `notes`.
- If rows are `compromise_ner`, the fallback path ran without LLM disambiguation; review before treating those links as resolved.
- If `bobsled doctor` reports mention orphans, check `chunker_config_hash` drift and supersede old mention rows before re-extraction.
- Do not bypass `resolved_entity_id` candidate-set validation. It is the primary guard against hallucinated entity links.
