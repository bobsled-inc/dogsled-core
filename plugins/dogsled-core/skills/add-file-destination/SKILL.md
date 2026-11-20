---
name: add-file-destination
description: Add a new file-based load destination (e.g., Azure Blob Storage,
  R2, MinIO) to the @bobsled-inc/loader package. Walks through class
  implementation, config schema, factory wiring, CLI options, check command, and
  tests.
---

# Add File Destination

Adds a new file-based destination to `packages/loader/`. File destinations implement the `FileDestination` interface and publish converted files (parquet, csv, jsonl) to a remote or local store. The canonical reference implementation is `S3Destination` (~85 lines).

## Usage

```
/add-file-destination <destination-name>
```

Example: `/add-file-destination azure-blob`

## Workflow

### Step 1: Check if destination already exists

```bash
ls packages/loader/src/runtime/destinations/
```

Look for a file matching the destination name. If it already exists, ask the user whether to update or abort.

Also check the factory to see if the destination kind is already in the `DestinationKind` union:

- **File:** `packages/loader/src/runtime/destinations/index.ts`

### Step 2: Study the reference implementation

Read these files to internalize the patterns before writing any code:

- `packages/loader/src/runtime/destinations/s3.ts` — canonical file destination (~85 lines)
- `packages/loader/src/runtime/destinations/types.ts` — `FileDestination` interface, `PublishOptions`, `assertObjectKeyLength()` and `normalizeDestinationPath()`
- `packages/loader/src/runtime/destinations/index.ts` — `DestinationKind` union, `DestinationConfig`, `createDestination()` factory
- `packages/loader/src/schemas/config.ts` — Zod discriminated union config schemas
- `packages/loader/src/commands/check.ts` — connectivity check functions and `CheckDependencies` DI
- `packages/loader/src/commands/run.ts` — CLI option registration (search for `--s3-bucket` to see the pattern)
- `packages/loader/tests/unit/destinations/s3.test.ts` — test structure and mock patterns

Key patterns to note:

| Pattern                                 | Why                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| **DI interface** (e.g., `S3ClientLike`) | Allows unit tests to inject a mock client instead of the real SDK                        |
| **Dynamic `import()`** for SDK          | The cloud SDK is an optional peer dep — must not be a static import                      |
| **Lazy client caching** (`getClient()`) | Creates the real SDK client on first use, caches it, but prefers injected client         |
| **`normalizeDestinationPath()`**        | Path traversal protection — call on both `prefix` (constructor) and `destPath` (publish) |
| **`publish()` returns a URI string**    | e.g., `s3://bucket/key` or `gs://bucket/key` — used for logging and state tracking       |
| **Constructor validation**              | Validate bucket/container naming rules at construction time, fail fast                   |

### Step 3: Implement the destination class

Create a new file at:

```
packages/loader/src/runtime/destinations/<name>.ts
```

The file must contain:

1. **A client-like DI interface** — minimal interface matching the SDK methods you call. Example from S3:

   ```typescript
   export interface S3ClientLike {
     send(command: unknown): Promise<unknown>;
   }
   ```

2. **An options interface** — includes the bucket/container name, optional prefix, optional region/account, and optional injected client:

   ```typescript
   export interface <Name>DestinationOptions {
     bucket: string;        // or container, etc.
     prefix?: string;
     region?: string;       // or account, endpoint, etc.
     <name>Client?: <Name>ClientLike;
   }
   ```

3. **A validation function** for bucket/container naming rules — fail fast with a clear error message. Research the cloud provider's naming rules (length, allowed characters, start/end constraints).

4. **The destination class** implementing `FileDestination`:
   - Import `normalizeDestinationPath` and `FileDestination` from `./types.js`
   - Store `bucketName`, `prefix` (normalized, trailing slashes stripped), `region`, `providedClient`, and `cachedClient` as private fields
   - Call the naming validation function in the constructor
   - Normalize the prefix in the constructor: `normalizeDestinationPath(options.prefix).replace(/\/+$/, '')`
   - `publish(localPath, destPath, options?)`:
     - Call `normalizeDestinationPath(destPath)`
     - Build the full object key using `path.posix.join(prefix, normalizedPath)` (or just `normalizedPath` if no prefix)
     - Call `assertObjectKeyLength(key)` on the final key, as S3 and GCS do
     - Dynamically import the SDK (`await import('...')`)
     - Read the local file (`await readFile(localPath)`)
     - Upload via the client. Set a content type only when `options?.copy` is not true
     - Return the URI string (e.g., `https://<account>.blob.core.windows.net/<container>/<key>`)
   - `getClient()`:
     - Return `this.providedClient` if set (DI path)
     - Return `this.cachedClient` if already created
     - Try dynamic `import()` of the SDK package
     - Wrap the import error with a helpful message: `"Failed to load <package>. Install it to use --dest <name>."`
     - Cache and return the new client

`options` is `PublishOptions` from `./types.js`: `{ copy?: boolean }`. The loader passes `{ copy: true }` for a `FILE` message, which writes a file as it is (a file Resource with `source.kind: copy`). A copy sets no content type, because the file is not in the loader's output format. A destination that should take copies must skip the content type when `copy` is true and check every final key with `assertObjectKeyLength()`, as `S3Destination` and `GcsDestination` do.

Only `local`, `s3` and `gcs` take copies today. `FILE_DESTINATION_TYPES` in `packages/dogsled/src/runner/config/validate-copy-destinations.ts` lists them, and `dogsled.yml` validation refuses a copy Resource whose destination has any other type. Add a new type there before a `dogsled.yml` pipeline copies files to it.

### Step 4: Add the Zod config schema

**File:** `packages/loader/src/schemas/config.ts`

Add a new schema object following the S3 pattern:

```typescript
const <Name>DestConfigSchema = z.object({
  dest: z.literal('<name>'),
  format: z.enum(OUTPUT_FORMATS),
  outputDir: z.string().trim().min(1).default('./output'),
  <name>Bucket: z.string().trim().min(1),       // or <name>Container, etc.
  <name>Prefix: z.string().trim().min(1).optional(),
  <name>Region: z.string().trim().min(1).optional(), // if applicable
  bufferSize,
  logFormat,
});
```

Then:

1. Add the new schema to the `LoaderConfigSchema` discriminated union array
2. Export the inferred type: `export type <Name>DestConfig = z.infer<typeof <Name>DestConfigSchema>;`
3. Add the new config type to the `FileDestConfig` union: `export type FileDestConfig = LocalDestConfig | GcsDestConfig | S3DestConfig | <Name>DestConfig;`

### Step 5: Wire the destination factory

**File:** `packages/loader/src/runtime/destinations/index.ts`

1. Import the new destination class:

   ```typescript
   import { <Name>Destination } from './<name>.js';
   ```

2. Add the new kind to the `DestinationKind` union:

   ```typescript
   export type DestinationKind = 'local' | 'gcs' | 's3' | '<name>';
   ```

3. Add the destination-specific fields to `DestinationConfig`:

   ```typescript
   <name>Bucket?: string;
   <name>Prefix?: string;
   <name>Region?: string;  // if applicable
   ```

4. Add a new `case` in `createDestination()` switch — before the `default` exhaustive check:

   ```typescript
   case '<name>':
     if (!config.<name>Bucket) {
       throw new Error('--<name>-bucket is required when --dest <name>');
     }
     return new <Name>Destination({
       bucket: config.<name>Bucket,
       prefix: config.<name>Prefix,
       region: config.<name>Region,
     });
   ```

5. Add a re-export at the bottom:
   ```typescript
   export { <Name>Destination } from './<name>.js';
   ```

### Step 6: Add the check command

**File:** `packages/loader/src/commands/check.ts`

1. Add an async `check<Name>()` function following the `checkS3` or `checkGcs` pattern:
   - Accept an options object (bucket/container, region, etc.) and `CheckDependencies`
   - Dynamically import the cloud SDK
   - Perform a lightweight connectivity check (e.g., head-bucket, get-container-properties, list with max-results=1)
   - Write success/failure to `stderr` using `chalk.green`/`chalk.red`
   - Call `setExitCode(1)` on failure

2. Add CLI options to the `check` command registration (inside `registerCheckCommand`):

   ```typescript
   .option('--<name>-bucket <bucket>', '<Name> bucket/container name')
   .option('--<name>-region <region>', '<Name> region')  // if applicable
   ```

3. Add a new `case '<name>':` in the `switch (dest)` block inside the `.action()` handler:
   - Validate required options are present
   - Call `check<Name>()`

4. Update the default error message to include the new destination in the list:

   ```typescript
   chalk.red('✗ --dest must be one of: duckdb, bigquery, gcs, local, s3, <name>');
   ```

5. Export the new check function at the bottom if it might be useful externally:
   ```typescript
   export { checkDuckDb, checkLocal, checkS3, check<Name> };
   ```

### Step 7: Wire CLI options in the run command

**File:** `packages/loader/src/commands/run.ts`

Search for the existing `--s3-bucket` option registrations and add analogous options nearby:

```typescript
.option('--<name>-bucket <bucket>', '<Name> bucket/container name')
.option('--<name>-prefix <prefix>', '<Name> object prefix')
.option('--<name>-region <region>', '<Name> region')  // if applicable
```

These options get passed through to the config object that feeds into `LoaderConfigSchema.parse()`, so they will flow through the Zod schema and into the factory automatically. Verify that the option names (camelCased by Commander) match the Zod schema field names exactly.

### Step 8: Write tests

Create a new test file at:

```
packages/loader/tests/unit/destinations/<name>.test.ts
```

Follow the `s3.test.ts` test structure exactly. Required test cases:

1. **Uploads files with bucket and prefix** — inject a mock client, call `publish()`, assert the returned URI and the arguments passed to the mock
2. **Uploads files without prefix** — verify the key has no prefix segment
3. **Rejects invalid bucket/container names** — test the constructor validation:
   - Too short
   - Too long
   - Invalid characters
   - Valid edge cases (minimum length, maximum length)
4. **Rejects traversal in prefix** — `new Destination({ bucket: 'b', prefix: '../escape' })` must throw `"Invalid destination path"`
5. **Rejects traversal in destination paths** — `publish('/tmp/f', '../escape.parquet')` must reject with `"Invalid destination path"`
6. **Clear error when SDK import fails** — construct without injecting a client, call `publish()`, assert the error message mentions the SDK package name
7. **Propagates upload errors** — inject a mock client that throws, assert the error propagates
8. **Accepts region/account config** — construct with region set, verify no error

Mock client pattern (from S3 tests):

```typescript
const mockClient = {
  async send(command: { input: Record<string, unknown> }): Promise<Record<string, never>> {
    uploads.push({
      bucket: command.input.Bucket as string,
      key: command.input.Key as string,
    });
    return {};
  },
};
```

Adapt the mock to match the SDK interface of the new cloud provider.

Run the tests:

```bash
pnpm --filter @bobsled-inc/loader test
```

All tests must pass.

## Quality Gates

Before considering the destination complete, verify all of the following:

| Gate                                | Command / Check                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript compiles                 | `pnpm --filter @bobsled-inc/loader typecheck`                                                                                                     |
| Lint passes                         | `pnpm --filter @bobsled-inc/loader lint`                                                                                                          |
| All unit tests pass                 | `pnpm --filter @bobsled-inc/loader test`                                                                                                          |
| Full repo builds                    | `pnpm build`                                                                                                                                      |
| Full repo type-check                | `pnpm typecheck`                                                                                                                                  |
| Exhaustive switch still works       | The `default: { const exhaustiveCheck: never = config.dest; }` in `createDestination()` must compile — ensures every `DestinationKind` is handled |
| Zod discriminated union valid       | `LoaderConfigSchema` must parse a config with `dest: '<name>'` and reject configs missing required fields                                         |
| `FileDestConfig` union updated      | The new config type is included in the `FileDestConfig` type alias                                                                                |
| No static imports of optional SDK   | The cloud SDK package must only appear inside `await import('...')` calls — never at the top of the file                                          |
| `normalizeDestinationPath()` called | Called on both the prefix (constructor) and destPath (publish) — prevents path traversal                                                          |
| Constructor validates naming rules  | Invalid bucket/container names throw synchronously at construction time                                                                           |
| `publish()` returns a URI string    | The URI uses the provider's canonical scheme (e.g., `s3://`, `gs://`, `https://...blob.core.windows.net/`)                                        |
| Copies written as they are          | With `{ copy: true }`, `publish()` sets no content type, and every key goes through `assertObjectKeyLength()`. A test covers both                 |
| DI interface enables testing        | A `*ClientLike` interface is exported and accepted in the options, so tests never need real SDK                                                   |
| Check command wired                 | `dogsled load check --dest <name> --<name>-bucket <b>` runs the connectivity check                                                                |
| Run command options wired           | `dogsled load run --dest <name> --<name>-bucket <b>` parses correctly                                                                             |

## Files Modified (Complete List)

| File                                                     | Change                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/loader/src/runtime/destinations/<name>.ts`     | **New** — destination class                                                        |
| `packages/loader/src/runtime/destinations/index.ts`      | Add import, `DestinationKind`, `DestinationConfig` fields, factory case, re-export |
| `packages/loader/src/runtime/destinations/types.ts`      | No changes needed (shared interface)                                               |
| `packages/loader/src/schemas/config.ts`                  | Add Zod schema, add to discriminated union, export type, update `FileDestConfig`   |
| `packages/loader/src/commands/check.ts`                  | Add check function, CLI options, switch case, error message update, export         |
| `packages/loader/src/commands/run.ts`                    | Add CLI options for bucket/prefix/region                                           |
| `packages/loader/tests/unit/destinations/<name>.test.ts` | **New** — unit tests                                                               |
