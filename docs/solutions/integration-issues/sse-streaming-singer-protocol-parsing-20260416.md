---
module: explorer
date: 2026-04-16
problem_type: integration_issue
component: api/command/route.ts, lib/use-command.ts, lib/protocol-parser.ts
symptoms:
  - 'CLI command output appears as raw JSONL in the terminal UI'
  - 'No real-time streaming — output only appears after command finishes'
  - 'LOG, METRIC, and PROGRESS messages not visually differentiated'
root_cause: Multi-layer architecture needed to bridge subprocess stdout/stderr to structured real-time UI output via SSE
severity: medium
tags: [sse, streaming, singer-protocol, jsonl, subprocess, real-time, terminal-ui]
---

# SSE Streaming + Singer Protocol Parsing for CLI Terminal UI

## Symptom

The Bobsled Core Explorer terminal page needs to show real-time, structured output from Bobsled Core CLI commands. Bobsled Core uses the Singer protocol: data flows as JSONL on stdout (SCHEMA, RECORD, STATE, BATCH) and control messages on stderr (LOG, METRIC, PROGRESS). Without proper streaming and parsing, output either appears all at once after the command finishes, or as undifferentiated raw text.

## Investigation

1. **Tried simple fetch + JSON response** — Command output only available after process exits. No streaming.
2. **Tried WebSockets** — Next.js App Router doesn't natively support WebSocket upgrade in Route Handlers. Would need a separate WS server.
3. **Tried polling** — Polling an endpoint for new output introduces latency and complexity (managing output buffers server-side).

## Root Cause

Three separate concerns must be solved together:

1. **Server**: Subprocess stdout/stderr must be forwarded to the client in real-time as they arrive
2. **Transport**: HTTP needs a streaming mechanism that works with Next.js Route Handlers
3. **Client**: Raw JSONL lines must be parsed into typed protocol messages for structured rendering

## Solution

Three-layer architecture: subprocess → SSE route → React hook → component.

**Layer 1: SSE Route Handler** (`api/command/route.ts`)

```typescript
const stream = new ReadableStream({
  start(controller) {
    const proc = spawn('node', [cliPath, command, ...args], { env });

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        controller.enqueue(`data: ${JSON.stringify({ stream: 'stdout', data: line })}\n\n`);
      }
    });

    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        controller.enqueue(`data: ${JSON.stringify({ stream: 'stderr', data: line })}\n\n`);
      }
    });

    proc.on('close', (code) => {
      controller.enqueue(`data: ${JSON.stringify({ stream: 'exit', code })}\n\n`);
      controller.close();
    });
  },
});

return new Response(stream, {
  headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
});
```

**Layer 2: React Hook** (`lib/use-command.ts`)

```typescript
// Reads SSE stream, splits on \n\n, parses JSON events
// Routes stderr lines through protocol parser for structured output
const output: CommandOutput = {
  stream: event.stream,
  raw: event.data,
  parsed: event.stream === 'stderr' ? parseProtocolLine(event.data) : undefined,
};
```

**Layer 3: Protocol Parser** (`lib/protocol-parser.ts`)

```typescript
// Attempts JSON.parse on each line, checks for Singer message types
// Returns { type: 'LOG'|'METRIC'|'PROGRESS'|'SCHEMA'|'RECORD', data: {...} }
// Falls back to null for non-JSON lines (plain text output)
```

**Layer 4: Terminal Component** (`terminal/page.tsx`)

```typescript
// Renders each output type with distinct styling:
// LOG → colored by level (error=red, warn=yellow, info=blue)
// METRIC → accent green with key:value pairs
// PROGRESS → primary indigo with event + resource name
// SCHEMA → warning amber with stream name
// RECORD → muted, truncated to 200 chars
// Plain text → default foreground
```

## Prevention

1. **Always use SSE for subprocess streaming in Next.js** — Native support via ReadableStream, no extra dependencies
2. **Parse at the edge, not in components** — The protocol parser lives in `lib/`, not in the component. Components receive typed data.
3. **Buffer management** — SSE events are delimited by `\n\n`. The client must handle partial events (maintain a buffer, split on delimiter, keep remainder).
4. **Include AbortController** — The `useCommand` hook supports cancellation via AbortController, which also kills the server-side subprocess.

## Related Issues

- Singer protocol specification: JSONL messages on stdout (data) / stderr (control)
- `@bobsled-inc/protocol` package defines the canonical message types
- The agent chat page (`api/agent/route.ts`) uses the same SSE pattern for Claude CLI streaming
