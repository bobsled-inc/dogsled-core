# @bobsled-inc/entity-graph

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Declarative entity resolution for Bobsled Core projects. Entity Graph compiles matching
rules into warehouse SQL and supports standardization, candidate blocking,
scoring, review, clustering, survivorship, lineage, and agent-assisted workflows.

## Install

Install `@bobsled-inc/bobsled-core`; this code ships inside it.

Most users run Entity Graph through the unified Bobsled Core CLI:

```bash
bobsled entity-graph resolve run --project-dir .
bobsled entity-graph review export --project-dir .
bobsled entity-graph resolve cluster --project-dir .
```

Programmatic workflows are available from the `api` export:

```typescript
import {
  compileResolveProject,
  inventoryEntityGraph,
  validateResolveProject,
} from '@bobsled-inc/entity-graph/api';
```

## Development

```bash
pnpm --filter @bobsled-inc/entity-graph build
pnpm --filter @bobsled-inc/entity-graph typecheck
pnpm --filter @bobsled-inc/entity-graph test:unit
```
