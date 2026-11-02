# Retail demo project notes

- Read `context/business-definitions.md` before changing metric SQL, joins, or prompts. Keep product joins on `product_id`; preserve null product identity when the support order is ambiguous.
- `generate.mjs` is the deterministic source of the committed CSV and JSON fixtures. Run it and `validate.mjs` after changing fixture logic. Do not put expected classifications into raw source rows.
- Keep offline fixture execution clearly labelled. Use the model-backed reference template for the learner's `executor.mjs`, retaining typed assignment/outcome validation, exact quotes, explicit cost enforcement and disabled retries. Never mark fixture output as AI chapter completion.
- `retail_api` is a loopback-only mock. For local API calls, explicitly set `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1`; do not change this project's API base URL to a public host.
