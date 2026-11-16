---
name: explorer-dev
description: Start developing on the Bobsled Core Explorer app. Use when working on the explorer UI, adding features, fixing bugs, or understanding the explorer architecture.
---

# Explorer Dev — Bobsled Core Explorer Development

Set up context and start working on the Bobsled Core Explorer app at `apps/explorer/`.

## Quick Reference

```bash
pnpm --filter @bobsled-inc/explorer dev        # Dev server on localhost:3333
pnpm --filter @bobsled-inc/explorer build      # Production build
pnpm --filter @bobsled-inc/explorer typecheck   # Type checking
pnpm --filter @bobsled-inc/explorer lint        # Linting
```

## Architecture

The explorer is a Next.js 15 app (App Router) at `apps/explorer/` in the monorepo. It reads integration and model data from workspace packages and spawns Dogsled CLI subprocesses.

```
apps/explorer/src/
  app/
    page.tsx                    # Dashboard (Server Component)
    layout.tsx                  # Root layout with sidebar
    not-found.tsx               # 404 page
    agent/page.tsx              # AI agent chat (spawns claude CLI)
    integrations/page.tsx       # Integration catalog (Client)
    integrations/[name]/page.tsx # Integration detail (Client)
    models/page.tsx             # Model bundles (Client)
    models/[name]/page.tsx      # Model detail (Client)
    pipelines/page.tsx          # Pipeline builder wizard (Client)
    pipelines/export/page.tsx   # Export config (Client)
    data/page.tsx               # DuckDB query editor (Client)
    terminal/page.tsx           # CLI runner with SSE (Client)
    entity-graph/page.tsx       # Entity Graph config (Client)
    setup/page.tsx              # Guided setup wizard (Client)
    docs/page.tsx               # Documentation (Server Component)
    api/                        # 9 API routes
  components/layout/sidebar.tsx # Navigation (10 items)
  lib/
    integrations.ts             # Wraps @bobsled-inc/integrations with clearCache()
    models.ts                   # Wraps @bobsled-inc/models with clearModelPackageCache()
    bobsled-cli.ts                # CLI subprocess spawning + workspace discovery
    protocol-parser.ts          # Dogsled protocol message parser
    use-command.ts              # React hook for SSE command streaming
```

## Key Patterns

### YAML Cache Clearing (CRITICAL)

Every server-side call to `@bobsled-inc/integrations` or `@bobsled-inc/models` MUST call `clearCache()` / `clearModelPackageCache()` in a `finally` block. The Next.js dev server is long-running and these libraries cache YAML in module-level Maps. Always use the wrappers in `lib/integrations.ts` and `lib/models.ts` — never import directly from the packages.

### CLI Subprocess Spawning

`lib/bobsled-cli.ts` discovers workspace root via `pnpm-workspace.yaml`, resolves Dogsled CLI from `packages/bobsled-core/dist/index.js` or falls back to `npx tsx packages/bobsled-core/src/index.ts`. Sets `BOBSLED_CORE_BUNDLED_INTEGRATIONS_DIR` and `NO_COLOR=1`.

### Command Security

`ALLOWED_COMMANDS` whitelist in `bobsled-cli.ts`. The `/api/command` route validates against this before spawning.

### SSE Streaming

`/api/command` and `/api/agent` return `text/event-stream`. Each line: `data: {"stream":"stdout"|"stderr"|"exit"|"error","data":"..."}`. The `useCommand` hook in `lib/use-command.ts` handles parsing.

### ESM Compatibility

`tsconfig.json` overrides monorepo's `NodeNext` with `bundler` for Next.js. `eslint.config.mjs` disables `dogsled/import-extension` rule (no `.js` extensions needed).

### Pipeline Config Passing

Pipeline builder passes config to export page via base64-encoded JSON URL search param (`?config=...`).

## Adding a New Page

Use the `/explorer-add-page` skill for the full scaffold workflow.

## Workflow

1. Read `apps/explorer/AGENTS.md` for local architecture rules
2. Start dev server: `pnpm --filter @bobsled-inc/explorer dev`
3. Make changes — Next.js hot reloads automatically
4. Verify: `pnpm --filter @bobsled-inc/explorer build` (catches type errors, SSR issues)
5. Check types: `pnpm --filter @bobsled-inc/explorer typecheck`

## Theme

Dark theme with CSS custom properties in `globals.css`:

- Primary: `#6366f1` (indigo) — CTAs, active states
- Accent: `#10b981` (green) — success, secondary actions
- Warning: `#f59e0b` (amber) — warnings
- Destructive: `#ef4444` (red) — errors
- Info: `#3b82f6` (blue) — informational
- Background: `#0a0a0a`, Card: `#111122`, Border: `#2a2a3e`
- Font: monospace stack (SF Mono, Fira Code, JetBrains Mono)

## Common Badge Variants

```tsx
<Badge variant="primary">type</Badge>      // indigo bg
<Badge variant="accent">success</Badge>    // green bg
<Badge variant="warning">warning</Badge>   // amber bg
<Badge>default</Badge>                      // gray bg
```

Text sizes: titles `text-xl`, sections `text-sm font-semibold`, body `text-xs`, micro `text-[10px]`.
