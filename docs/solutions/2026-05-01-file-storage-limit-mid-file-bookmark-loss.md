# File Storage Limit Mid-File Bookmark Loss

## Problem

`packages/extractor/src/runtime/file-storage-extractor.ts` bookmarked files as fully processed even when `--limit` caused iteration to stop mid-file:

```ts
for (const record of read.records) {
  if (limit !== undefined && recordCount >= limit) break;
  await emitter.emitRecord(resource.name, record, pageTime);
  recordCount += 1;
}
nextFiles[file.uri] = bookmarkFor(file); // bookmarked even if we stopped mid-file!
filesProcessed += 1;
if (limit !== undefined && recordCount >= limit) break;
```

The bookmark (`etag` / `size` / `mtime`) was written to `nextFiles` unconditionally. On the next incremental run the file matched and was skipped entirely, silently dropping every record that was never emitted.

## Solution

Track whether the limit was hit mid-file and only bookmark files that were fully consumed:

```ts
let limitHitMidFile = false;
for (const record of read.records) {
  if (limit !== undefined && recordCount >= limit) {
    limitHitMidFile = true;
    break;
  }
  await emitter.emitRecord(resource.name, record, pageTime);
  recordCount += 1;
}
// Only bookmark files we fully consumed
if (!limitHitMidFile) {
  nextFiles[file.uri] = bookmarkFor(file);
  filesProcessed += 1;
}
if (limit !== undefined && recordCount >= limit) break;
```

## Why This Matters

`--limit` runs are non-durable by default — state isn't persisted unless `--advance-state` is also passed. But `nextFiles` is written into the STATE message regardless, and when `advanceState` is true the partial-file state gets durably saved.

The result is silent, permanent data loss: the next full run sees the bookmarked file as already processed and skips it with no error or warning.

The pattern is easy to miss in review because "bookmark a file after processing it" looks correct — the subtle error is that processing stopped before the file was exhausted.

Key rules to avoid recurrence:

1. A file should be bookmarked only when all of its records have been emitted.
2. Any early-exit path (limit, error, cancellation) must leave the bookmark unset so the file is re-processed on the next run.
3. When state is written unconditionally, treat every entry in that state as durable — even in "non-durable" flag combinations.
