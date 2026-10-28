---
module: dogsled extract pipelines
date: 2026-07-28
problem_type: logic_error
component: public runProjectPipeline projection
symptoms:
  - 'runProjectPipeline rejected canonical load_strategy, table, and inputs resource fields.'
  - 'Delimited input forwarding could corrupt array entries containing commas.'
  - 'Table overrides could break metrics attribution or let two streams share loader state.'
root_cause: The public pipeline projection forwarded via only and lacked explicit extractor/loader ownership for the other canonical resource overrides.
severity: high
tags: [pipeline, resource-overrides, extractor, loader, public-api]
---

# Faithful Per-Resource Pipeline Overrides

## Symptom

`dogsled.yml` accepted per-resource `via`, `load_strategy`, `table`, and `inputs`, but the
public `runProjectPipeline` path rejected every field except `via`. A library consumer
would therefore need to parse Dogsled YAML again or invoke lower-level CLI commands to
avoid dropping valid configuration.

Naive forwarding introduced further hazards: arrays joined with commas no longer matched
array input decoding; sibling inputs could leak; final table names could no longer identify
the raw stream for metrics; and two streams resolving to one table could share buffers,
strategies, and checkpoints.

## Investigation

The canonical configuration was traced through entity/variant resolution, public
selection, subprocess argument construction, extractor input resolution, loader stream
state, multi-destination fan-out, and summary parsing. Each field has one natural owner:
`via` and `inputs` belong to extraction, while `load_strategy` and `table` belong to
database loading.

## Root Cause

The public projection stopped at `via` and had no typed per-resource maps. The extractor
only had pipeline-wide `--input`, and the loader keyed internal state by its resolved
table name without retaining the original stream identity.

## Solution

- Project canonical overrides automatically from resolved pipeline resources; do not ask
  callers for a duplicate override structure.
- Key all maps by the resolved resource name and forward only selected resources.
- Carry resource inputs in one JSON envelope, serialize array values as JSON, validate
  targeted keys, and merge them only into the named resource.
- Add repeatable loader stream strategy/table flags, validate identifiers, and preflight
  explicit table collisions before destination initialization.
- Preserve the raw protocol `stream` on structured load events so metrics remain correct
  after table renaming and fan-out.
- Keep child telemetry structured even when the parent presents pretty logs, and reject
  duplicate resolved streams before keyed override maps can collapse them.
- Make invocation-level full refresh authoritative for loading: force the global
  `full_refresh` strategy and omit authored per-stream strategies, which otherwise have
  higher loader precedence.
- Reject file-destination table/strategy overrides, invalid explicit selections, and
  selected `for_each` children missing their parent before spawning; explicit
  `for_each_parent` metadata must match a known spec edge when that spec is available.

## Prevention

Contract tests should cover every override alone and combined, sibling isolation,
authored-to-resolved names, narrowed selection, pipeline defaults, multi-destination
fan-out, full refresh against conflicting pipeline and resource strategies, entity aliases
that resolve to the same concrete resource, array delimiters reaching an actual HTTP
request, collision preflight before writes, state/cancellation behavior, and canonical
validation diagnostics.

## Related Issues

- LangGraph for_each resource grouping (the note is no longer in this repository)
