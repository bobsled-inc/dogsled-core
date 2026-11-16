# Delegated CLI Test Close Race

## Problem

`packages/bobsled-core/tests/unit/runtime/delegation.test.ts` used a fixed `setTimeout(..., 50)` to emit the mocked child process `close` event. That passed in focused runs but could time out in the full `pnpm precommit` workflow when `runDelegatedCli()` spent longer resolving the dynamic `@bobsled-inc/integrations` import before `waitForProcess()` attached its listener.

## Solution

For the direct `runDelegatedCli()` tests, stop relying on a timer. Start the command, wait until the mocked `spawn()` call is observed, then emit `close` from the test body. Keep the timer-based helper only for `maybeRunDelegatedCommand()` cases where the command path is already under test and the subprocess close timing is not the subject of the assertion.

## Why This Matters

The delegated CLI path mixes dynamic imports and subprocess lifecycle wiring. Timer-based test completion looks simple but couples correctness to machine speed and suite load. Emitting `close` only after `spawn()` is observed makes the test deterministic and keeps `pnpm precommit` representative of real regressions rather than scheduling noise.
