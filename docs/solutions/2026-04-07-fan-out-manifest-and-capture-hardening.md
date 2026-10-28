# Fan-Out Manifest and Capture Hardening

## Problem

Multi-destination fan-out already deferred state commit until every loader succeeded, but it still had three operational gaps:

1. There was no durable run manifest for postmortems or replay debugging.
2. The capture directory was always deleted, even when downstream loaders failed.
3. Unsupported destination/load-strategy combinations were only discovered after extraction had already run.

## Solution

Harden the fan-out path around the captured extractor output:

1. Add a `manifest.json` written into the capture directory with extractor exit status, per-destination outcomes, row counts, and state-commit status.
2. Preserve the capture directory on any failed or killed fan-out run, and log the preserved path explicitly so operators can replay it.
3. Validate destination capabilities before extraction starts so merge/file mismatches fail fast with a validation error.
4. Compare extractor record counts against each destination's loaded row counts before fan-out summaries are merged, and emit warn-level mismatches instead of silently collapsing the discrepancy.

## Why This Matters

Fan-out replay is only useful if operators can find the captured data, understand which destination failed, and avoid paying the extraction cost again for obviously invalid configurations. The manifest plus preserved capture directory turns the multi-destination path into a debuggable, replayable workflow instead of a one-shot temp-file implementation.
