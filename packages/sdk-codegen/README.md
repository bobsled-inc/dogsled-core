# @bobsled-inc/sdk-codegen

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Generates typed SDK files from a Bobsled Core entity graph inventory.

## CLI

```bash
bobsled sdk generate --lang ts --out ./generated/bobsled-sdk --json
```

The emitted TypeScript SDK includes:

- branded entity ID types;
- per-entity profile interfaces;
- shared `EntityQuality`;
- `createBobsledClient(executor)` with typed `findBy(...)`, `withDocuments()`, `withRelationship(...)`, `all()`, and `first()`.

The SDK is generated into the consumer repo. Generated SDK package publishing is not part of v1.

## Library

```ts
import { emitPythonSdk, emitTypeScriptSdk, parseSdkIr } from '@bobsled-inc/sdk-codegen';

const ir = parseSdkIr(rawInventory);
const tsFiles = emitTypeScriptSdk(ir);
const pyFiles = emitPythonSdk(ir);
```

The Python emitter produces pydantic v2 profile models for library consumers. The CLI intentionally ships TypeScript only in v1.

## Executor Contract

Generated TypeScript clients are executor-backed. Apps own the warehouse/API connection and return profile rows plus requested includes.

```ts
import { createBobsledClient, type BobsledEntityExecutor } from './generated/bobsled-sdk/index.js';

const executor: BobsledEntityExecutor = {
  async find(request) {
    return queryBobsledServingTables(request);
  },
};

const bobsled = createBobsledClient(executor);
const customer = await bobsled.entity.customer
  .findBy({ domain: 'acme.com' })
  .withDocuments()
  .first();
```

See [`docs/reference/advanced/sdk-codegen.md`](../../docs/reference/advanced/sdk-codegen.md) for the full user guide.
