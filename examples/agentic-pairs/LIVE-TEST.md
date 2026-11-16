# Live test — 13 September 2026

The standalone Bobsled Core CLI passed with OpenAI `gpt-4.1-mini` and a real provider call for each pair.
The test used the synthetic input from this project. It did not use a mock provider.

| Pair   | LLM assessment        | SQL action            | Merge authorized |
| ------ | --------------------- | --------------------- | ---------------- |
| pair-1 | same_user             | review_merge          | false            |
| pair-2 | different_user        | keep_separate         | false            |
| pair-3 | insufficient_evidence | request_more_evidence | false            |

All three models succeeded: `undecided_pairs`, `pair_assessments`, and `pair_decisions`.
The executor made three calls. All three attempts succeeded on their first call.
The provider reported 1,689 input tokens and 450 output tokens, for a total of 2,139 tokens.
Bobsled Core saved the same total charge.

A second CLI process used the same run ID with `--agent-resume`.
The resume succeeded and made zero new executor calls.
An observation module recorded each executor invocation and then called the unchanged real executor.
It did not replace the AI client or provider response.

The live test first found a provider schema error.
The local row validator uses a JSON guard before its object schema.
The SDK converted that guard into an input schema without an object type.
OpenAI rejected the schema before inference.
The executor now sends the concrete object schema to the provider.
It still applies the full local result validator after the call.
The executor test checks the input-side JSON schema to prevent this failure.

## Evidence timestamp correction

The first live run returned unsupported evidence dates from 2024.
The LLM supplied those dates because the provider schema required them.
The original assessment checks did not catch this metadata error.

The corrected run also passed with three real OpenAI calls.
Bobsled Core recorded `2026-09-13T11:38:05.554Z` when it received the prepared input.
Every published evidence date equals that saved host time.
The provider schema has no retrieval date field.
The executor attaches the host time after it validates the response.
The resume preserved the input time and made zero new calls.
The token counts above describe this corrected run.

## Scope

This test proves the CLI, LLM call, result validation, saved state, DuckDB publication, and downstream SQL path.
It does not prove general entity-resolution accuracy or a full entity-resolution pipeline.
It does not test candidate discovery, clustering, record merges, Bobsled Core, or a live cloud database.

## Repeat the test

Use the setup and run commands in [README.md](README.md).
Use a valid provider key through environment indirection.
Use a new run ID for a fresh test.
Use the same ID with `--agent-resume` for the resume check.

## Agent loop — 14 September 2026

A separate local restaurant demo used the reference loop with OpenAI
`gpt-4.1-mini` and real DuckDB source reads. It kept the previous demo's public
Fodors–Zagats seeds, 30 candidate pairs, and ten SQL models unchanged. A new
work-list model supplied only the pair ID. Each agent read the candidate table
through Bobsled Core before it returned its assessment.

The completed run used concurrency 3. All 30 assignments succeeded, with 60 real
LLM calls and 30 source reads. The provider reported 166,860 tokens. All twelve
models completed in 77.1 seconds. SQL produced four correct links, no wrong
links, one pair for review, and 59 entities covering all 63 source records.
Three of the seven known matches were missed. Labels were used only for evaluation.
These small-run results do not establish general accuracy.

A second CLI process resumed the same run. It made zero new executor calls,
LLM calls, or source reads. State checks verified successful saved work,
confirmed publication, measured usage, and evidence dates from the actual
source responses.

The initial live attempts exposed two response-schema problems. OpenAI rejected
`oneOf`, so the reference loop now emits `anyOf`. The read schema also allowed a
search string, which the runtime correctly rejected. The provider schema now
requires null search for reads and null columns for searches. A regression test
checks these schema constraints. Failed diagnostic attempts are excluded from
the completed-run counts above.
