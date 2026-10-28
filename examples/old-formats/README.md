# Legacy and broken configuration

This is a test-only safety check, not a data-project walkthrough.

Run `pnpm e2e:old-formats` from a built checkout. This negative walkthrough never
opens a network connection. It validates deprecated Blueprint keys with warnings,
checks conflicting aliases fail with `LEGACY_KEY_CONFLICT`, rejects the retired
lakehouse destination with a canonical replacement hint, rejects a v6 manifest,
and checks malformed YAML produces a structured CLI failure.

The test intentionally contains retired identifiers so consumers can reproduce
the migration. See the deprecated-field table in
`docs/guides/dogsled-cloud.md` for the supported migration.

Known limitation: an old root configuration filename currently lacks a dedicated
migration diagnostic. The test checks it does not crash; the missing migration
hint is explicitly reported as a remaining defect.
