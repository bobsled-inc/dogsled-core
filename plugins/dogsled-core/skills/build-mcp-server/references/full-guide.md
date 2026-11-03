# Build a remote MCP server

Use this when a user wants to **expose their own data or operations as a
remote MCP server** so the host agent (or any MCP client) can pull
data from it. The endgame: a publicly reachable HTTPS URL implementing
the streamable-HTTP MCP transport, which you then wire up via
`add-custom-mcp-integration` as a Dogsled `custom_mcp` source.

This skill is **not** about consuming MCP — for that, run
`add-custom-mcp-integration` (or `mcp-discover` to scaffold from an
existing server's tools).

## What you're building

A long-running HTTPS service that:

1. Implements the **Model Context Protocol** JSON-RPC over HTTP +
   Server-Sent Events (the streamable-HTTP transport).
2. Exposes a set of **tools** an MCP client can call (`tools/list`,
   `tools/call`).
3. Authenticates incoming requests (`bearer` or `api-key` for the
   simplest production-ready shape — Dogsled's `custom_mcp` reads both).
4. Lives at a stable HTTPS URL the extractor can reach.

The protocol spec is at https://spec.modelcontextprotocol.io/. The
authoritative SDKs are
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
(TypeScript) and
[`mcp`](https://github.com/modelcontextprotocol/python-sdk) (Python).
**Verify the current API shape against each SDK's README before
copy-pasting** — the SDKs are pre-1.0 and add/rename helpers between
minor versions.

## Prerequisites

- A place to host an **always-on HTTPS endpoint** with HTTP/1.1
  keep-alive and SSE support. Streamable HTTP holds the response stream
  open for the agent to consume — short-timeout serverless runtimes
  (Lambda 30s, Vercel Hobby 10s) **won't work** for tools that stream
  incremental progress. Long-running tools need:
  - Cloud Run (60-minute request timeout).
  - Fly.io (no enforced timeout on the worker side).
  - Render / Railway / a dedicated VM.
- A TLS-terminating load balancer or platform that provisions a cert
  for you. Self-signed certs are rejected by Dogsled's
  `AbsoluteHttpsUrlSchema` callers and DNS pre-resolution.
- Secrets management for the auth token: environment variables for
  small deploys, GCP Secret Manager / AWS Secrets Manager / Vault for
  production.

## Step 1 — Pick a language + SDK

### TypeScript (most active)

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod
npm install --save-dev typescript tsx @types/node
npx tsc --init
```

Minimum `tsconfig.json` adjustments: `"module": "NodeNext"`,
`"target": "ES2022"`, `"moduleResolution": "NodeNext"`.

### Python

```bash
mkdir my-mcp-server && cd my-mcp-server
uv init
uv add "mcp[cli]"
```

The Python SDK uses Pydantic models and supports both stdio (for
desktop Claude) and streamable HTTP (for hosted access — that's what
you want for Dogsled).

## Step 2 — Define tools

A tool is a typed function the MCP client can invoke. Give it a clear
name, a JSON Schema for arguments, and a handler that returns
serializable JSON.

### TypeScript

```ts
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'my-team-tools',
  version: '0.1.0',
});

server.tool(
  'list_projects',
  'List projects in the team',
  {
    team_id: z.string().describe('UUID of the team'),
    limit: z.number().int().min(1).max(100).default(50),
  },
  async ({ team_id, limit }) => {
    const rows = await db.query(
      'select id, name, status, created_at from projects where team_id = $1 limit $2',
      [team_id, limit]
    );
    // Streamable HTTP returns "content" parts; the conventional shape
    // for data tools is a single text part holding JSON.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ projects: rows }),
        },
      ],
    };
  }
);

server.tool(
  'get_project',
  'Get a single project by id',
  { project_id: z.string() },
  async ({ project_id }) => {
    const row = await db.query('select * from projects where id = $1', [project_id]);
    if (!row) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'not_found' }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ project: row }) }],
    };
  }
);

export { server };
```

### Python

```python
# server.py
from mcp.server import FastMCP
from pydantic import Field

mcp = FastMCP("my-team-tools")

@mcp.tool()
def list_projects(
    team_id: str = Field(description="UUID of the team"),
    limit: int = Field(default=50, ge=1, le=100),
) -> dict:
    """List projects in the team."""
    rows = db.query(
        "select id, name, status, created_at from projects where team_id = %s limit %s",
        (team_id, limit),
    )
    return {"projects": rows}

@mcp.tool()
def get_project(project_id: str) -> dict:
    """Get a single project by id."""
    row = db.query("select * from projects where id = %s", (project_id,))
    if not row:
        return {"error": "not_found"}
    return {"project": row}
```

The `@mcp.tool()` decorator infers the JSON Schema from the function
signature. Pydantic `Field(description=...)` becomes the schema's
`description`.

## Step 3 — Expose over streamable HTTP

Streamable HTTP combines:

- **POST `/mcp`** — JSON-RPC request body, used for initialization
  (`initialize`), tool listing (`tools/list`), and tool calls
  (`tools/call`).
- **GET `/mcp`** — SSE stream the server uses to push notifications and
  long-running tool results.

Auth lives in HTTP headers (`Authorization: Bearer ...` or a custom
`x-api-key`). Cookies are also supported but headers are simpler.

### TypeScript (Express)

```ts
// src/index.ts
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { server } from './server.js';

const app = express();
app.use(express.json({ limit: '4mb' }));

// Bearer-token middleware (see Step 4).
app.use('/mcp', requireBearer(process.env.MCP_AUTH_TOKEN!));

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await server.connect(transport);

// Handle both POST (request) and GET (SSE stream) on /mcp.
app.all('/mcp', async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`MCP server listening on :${port}/mcp`);
});
```

### Python (built-in streamable_http_app)

```python
# main.py
import os
from server import mcp

# FastMCP exposes streamable_http_app() which returns a Starlette app.
app = mcp.streamable_http_app()

# Mount auth middleware around it (see Step 4).
from middleware import RequireBearerMiddleware
app.add_middleware(RequireBearerMiddleware, token=os.environ["MCP_AUTH_TOKEN"])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
```

## Step 4 — Auth

Dogsled's `custom_mcp` reads three auth shapes off
`McpTransportAuthSchema`: `none`, `bearer`, `api-key`. Implement
whichever fits your security model. **Always** compare tokens with a
constant-time function and **never** log the raw token.

### Bearer token (TypeScript)

```ts
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export function requireBearer(expected: string) {
  const expectedBuf = Buffer.from(expected, 'utf-8');
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) {
      res.status(401).json({ error: 'missing_bearer' });
      return;
    }
    const presented = Buffer.from(match[1], 'utf-8');
    if (presented.length !== expectedBuf.length || !timingSafeEqual(presented, expectedBuf)) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    next();
  };
}
```

### API-key header (TypeScript)

```ts
const HEADER = 'x-api-key';
const keys = (process.env.MCP_API_KEYS ?? '').split(',').filter(Boolean);

app.use('/mcp', (req, res, next) => {
  const presented = req.header(HEADER);
  if (!presented) return res.status(401).json({ error: 'missing_api_key' });
  // Constant-time compare across the allowed key set.
  const presentedBuf = Buffer.from(presented, 'utf-8');
  const ok = keys.some((k) => {
    const kBuf = Buffer.from(k, 'utf-8');
    return kBuf.length === presentedBuf.length && timingSafeEqual(kBuf, presentedBuf);
  });
  if (!ok) return res.status(401).json({ error: 'invalid_api_key' });
  next();
});
```

### Bearer token (Python middleware)

```python
import hmac
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

class RequireBearerMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str):
        super().__init__(app)
        self.token = token.encode("utf-8")

    async def dispatch(self, request, call_next):
        if not request.url.path.startswith("/mcp"):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return JSONResponse({"error": "missing_bearer"}, status_code=401)
        presented = header[len(prefix):].encode("utf-8")
        if not hmac.compare_digest(presented, self.token):
            return JSONResponse({"error": "invalid_token"}, status_code=401)
        return await call_next(request)
```

### When to choose what

- **`type: bearer`** — simplest, single shared secret, rotate by
  redeploying. Best for an internal server consumed by a small number
  of clients.
- **`type: api-key`** — per-client keys (the `keys` slice above), so
  you can revoke one client without rotating all of them. Best for
  multi-tenant servers or when you want to attribute calls.
- **`type: none`** — only for truly public read-only data. Dogsled
  accepts it but the SSRF + rate-limit on the extractor side is your
  only defense.
- **OAuth2 client_credentials** — Dogsled's MCP schema accepts it
  (`token_url`, `client_id`, `client_secret`, `scopes`). The MCP SDK
  side requires you to validate the JWT yourself. Out of scope for
  this skill — use it when you have an existing OIDC IdP and need
  per-token scoping.

## Step 5 — Test locally before deploying

Set `MCP_AUTH_TOKEN` to the same temporary local test token in both terminals, then run the server locally:

```bash
# TypeScript
npx tsx src/index.ts
# Python
uv run python main.py
```

In a second terminal, probe with `curl`:

```bash
# Initialize the session — capture the Mcp-Session-Id from the response.
curl -i -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "curl", "version": "0.0.1"}
    }
  }'

# Then list tools (replace <SID> with the value of Mcp-Session-Id from above).
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Mcp-Session-Id: <SID>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Or use the MCP Inspector for a richer UI:

```bash
npx @modelcontextprotocol/inspector http://localhost:8080/mcp
```

Once the inspector connects and lists your tools, you have a working
MCP server. Point Dogsled's `mcp-discover` skill at the same URL to
auto-scaffold the resource YAML, then refine it with
`add-custom-mcp-integration`.

## Step 6 — Deploy

Three concrete recipes. Pick the platform that matches your team's ops
posture.

### Cloud Run

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

```bash
# Build and deploy in one shot. --timeout=3600 lets streamable HTTP
# hold the SSE stream open for up to an hour per request.
gcloud run deploy my-mcp-server \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout=3600 \
  --set-secrets MCP_AUTH_TOKEN=mcp-auth-token:latest \
  --memory 512Mi
```

Cloud Run will return an HTTPS URL like
`https://my-mcp-server-<hash>-uc.a.run.app`. Use `https://<that>/mcp`
as the `url` in your Dogsled `custom_mcp` source.

### Fly.io

```toml
# fly.toml
app = "my-mcp-server"
primary_region = "iad"

[build]
  builder = "paketobuildpacks/builder:base"

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false   # streamable HTTP needs a long-lived process
  auto_start_machines = true
  min_machines_running = 1

  [http_service.checks]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/mcp"
    protocol = "http"
    timeout = "5s"
```

```bash
fly launch --no-deploy   # accept defaults, edit fly.toml as above
fly secrets set MCP_AUTH_TOKEN=...
fly deploy
```

### Vercel (Edge / Node)

Vercel works **only for short tool calls** — Pro plans cap function
duration at ~30 minutes (and Hobby at 10 seconds). If your tools
return quickly and don't stream incremental progress for hours, it's
viable; otherwise pick Cloud Run or Fly.

```jsonc
// vercel.json
{
  "functions": {
    "api/mcp.ts": {
      "maxDuration": 300,
    },
  },
}
```

Use `api/mcp.ts` to handle both POST and GET; the StreamableHTTPServerTransport
fits in a Node serverless function as long as you allocate enough
`maxDuration`.

## Step 7 — Connect it back via Dogsled

Once your server is at a stable HTTPS URL, hand off to
`add-custom-mcp-integration`:

1. The server's URL becomes `transports[0].url` in the Dogsled
   `source.yml`.
2. The bearer token / api-key becomes `${{ env.<VAR> }}` in
   `transports[0].auth`, declared in `auth_env_vars`.
3. For each tool you exposed, author one resource under
   `resources/<tool>.yml` with the `tool:` block.
4. `dogsled extract validate <source>` → `verify` → `run`.

```yaml
# Your Dogsled source.yml after deploy:
spec_version: '2'
type: source
source_type: custom_mcp
dogsled_source_kind: custom_mcp
name: my_team_tools
auth_env_vars:
  - MY_TEAM_MCP_TOKEN
transports:
  - id: default
    type: mcp_http
    url: https://my-mcp-server-<hash>-uc.a.run.app/mcp
    auth:
      type: bearer
      token: ${{ env.MY_TEAM_MCP_TOKEN }}
default_transport: default
```

## Security checklist

Before exposing the server publicly:

- [ ] **HTTPS only.** Reject HTTP at the load balancer. Dogsled's
      `AbsoluteHttpsUrlSchema` enforces it on the connection too.
- [ ] **Auth on every tool.** Don't ship a read-write tool without
      auth. Even read-only tools should be auth'd for rate-limiting.
- [ ] **Constant-time token compare.** Use `timingSafeEqual` /
      `hmac.compare_digest`. Never `===` / `==` on secret tokens.
- [ ] **Rate-limit per token.** A misbehaving client shouldn't be able
      to DoS the server. 60 req/min per token is a sensible floor.
- [ ] **Never echo tokens.** Logs, error messages, response bodies —
      scrub them.
- [ ] **No internal admin tools.** Don't expose database admin, secret
      rotation, or internal RPC methods as MCP tools. The MCP surface
      is a public API contract.
- [ ] **SSRF on input.** If any of your tools fetch URLs from
      caller-supplied input, validate them against an allowlist.
- [ ] **Input size caps.** Cap request body size (Express
      `express.json({ limit: '4mb' })`, Starlette via middleware).
- [ ] **Resource quotas in tool handlers.** Cap SQL `LIMIT`, page
      counts, file sizes per call.

## Reference resources

- MCP spec — https://spec.modelcontextprotocol.io/ (authoritative).
- TypeScript SDK README —
  https://github.com/modelcontextprotocol/typescript-sdk.
- Python SDK README —
  https://github.com/modelcontextprotocol/python-sdk.
- MCP Inspector —
  https://github.com/modelcontextprotocol/inspector (testing UI).

When authoring this skill's worked examples, fetch the **current** SDK
API shape with the context7 MCP server (`query-docs` tool) — the SDKs
add and rename helpers between minor versions, and stale syntax is the
top failure mode.

## Related

- `add-custom-mcp-integration` — connect your deployed MCP server as a
  Dogsled `custom_mcp` source (the natural next step).
- `mcp-discover` — auto-scaffold Dogsled resource YAML from your
  server's `tools/list` output.
