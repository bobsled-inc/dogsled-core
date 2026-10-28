# @bobsled-inc/explorer — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

Local-first Next.js app for configuring, teaching, and demoing Dogsled. It is not a
hosted production control plane.

## Boundaries

- Use wrappers in `src/lib/integrations.ts` and `src/lib/models.ts`; they clear
  package YAML caches after server-side reads.
- Spawn Dogsled only through `src/lib/dogsled-cli.ts` and preserve its command allowlist.
- Keep durable curriculum content under `src/lib/learn-curriculum.ts`; journeys are
  short product tours.
- Do not import the Dogsled CLI runtime into Next.js pages.
- Keep Next.js `bundler` module resolution and the local ESLint import-extension
  exception; workspace packages themselves remain NodeNext.

## Security

- Never expose arbitrary shell execution from an API route.
- Credential APIs may return allowlisted variable names and presence booleans, never
  environment values.
- Guard all user-controlled workspace paths and SQL/table selections with existing
  allowlists and containment helpers.
- SSE routes emit structured events and must not leak raw secrets in stderr bodies.

## Development

Build workspace packages before starting Explorer in a fresh worktree.

```bash
pnpm --filter @bobsled-inc/explorer dev
pnpm --filter @bobsled-inc/explorer build
pnpm --filter @bobsled-inc/explorer typecheck
pnpm --filter @bobsled-inc/explorer lint
pnpm --filter @bobsled-inc/explorer test:unit
```
