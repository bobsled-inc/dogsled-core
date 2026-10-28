# Mutex Token Identity Bug

## Problem

`apps/explorer/src/app/api/demo/aurelia/reset/route.ts` used a module-level singleton lock to prevent concurrent workspace resets. The release function compared object identity (`activeReset === token`), but the helper that claimed the lock and the route handler each constructed their own structurally-identical `{ cancel }` object — two different references with the same shape:

```ts
function claimReset(token: { cancel: () => void }): boolean {
  if (activeReset) return false;
  activeReset = { cancel: token.cancel };  // object #1, freshly allocated
  return true;
}
function releaseReset(token: { cancel: () => void }): void {
  if (activeReset === token) activeReset = null;   // never matches
}

// in POST():
const claimToken = { cancel };    // object #2, separate reference
if (!claimReset(claimToken)) { ... }
...
releaseReset(claimToken);          // identity check fails forever
```

After the first reset finished (success, failure, timeout, or stream cancel), `activeReset` stayed set. Every subsequent POST hit the 409 branch. The Reset Workspace button feature was broken after the first click of the dev server's lifetime — but only on the second invocation, so unit-style smoke tests that ran one reset never caught it.

## Solution

Have the claim function accept and store the caller's exact token reference, so the identity check in release is meaningful:

```ts
function claimReset(token: { cancel: () => void }): boolean {
  if (activeReset) return false;
  activeReset = token;            // store the caller's reference
  return true;
}
// caller:
const claimToken = { cancel };
if (!claimReset(claimToken)) { ... }
...
releaseReset(claimToken);          // identity matches
```

Alternatively, drop the identity check entirely and just `activeReset = null` on release — but only if there's exactly one release path. With multiple release paths (`finally` block + stream `cancel()` callback), the identity check prevents a stale release from clearing a newer claim.

## Why This Matters

`{ x } === { x }` is `false`. Two structurally-identical objects are not the same reference. JavaScript identity checks on freshly-allocated objects with the same shape are a silent footgun:

- Looks correct at a glance — both objects "have a `cancel` field that does the same thing".
- Tests don't catch it if they only exercise one trip through the lock.
- The failure mode is "feature works once, then never" — easy to mistake for "works on my machine" when the dev server has been restarted between attempts.

When using identity-based mutex tokens in JS/TS:

1. The thing that claims the lock and the thing that releases it must hold the **same reference**, not a copy.
2. Easiest pattern: caller allocates the token, passes it to claim, holds onto it for release.
3. If you reach for `===` to compare two object references and they were each constructed by separate `new`/`{...}` calls, you have a bug.
4. For dev-only mutexes, prefer `let activeReset: { cancel: () => void } | null = null` and `if (activeReset) return false` — skip the per-call token entirely if you only have one release path. Add the identity check only when you have multiple release paths and want to prevent a stale release from clearing a newer claim.

The same pattern recurs anywhere code passes a "handle" that's used to look up resources later — request IDs, animation frames, abort controllers. If the handle is just `{}` (or any fresh allocation), the identity check is meaningless. Use the **same reference** end-to-end, or use a stable id (a counter, a UUID) that you can compare with `===` on primitives.
