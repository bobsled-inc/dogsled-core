---
module: explorer
date: 2026-04-16
problem_type: security_issue
component: lib/bobsled-cli.ts, api/command/route.ts
symptoms:
  - 'Web UI needs to execute CLI commands on the server'
  - 'Arbitrary command injection risk via POST /api/command endpoint'
root_cause: Exposing subprocess execution via HTTP requires explicit command validation to prevent injection
severity: critical
tags: [security, command-injection, subprocess, whitelisting, api-safety]
---

# Command Whitelisting for Subprocess Execution

## Symptom

The Bobsled Core Explorer needs a terminal page that runs `bobsled` CLI commands via a web API. The `/api/command` endpoint accepts a POST body with `{ command, args }` and spawns a subprocess. Without validation, this is a direct command injection vulnerability — any string could be executed on the server.

## Investigation

1. **Considered shell execution** — Using `child_process.exec()` with string interpolation would allow shell metacharacter injection (`; rm -rf /`). Rejected immediately.
2. **Considered argument escaping** — Libraries like `shell-escape` help but are fragile and don't prevent the fundamental issue of running unintended commands.
3. **Considered dynamic validation** — Parsing `bobsled --help` output to discover valid commands. Too complex and could change between versions.

## Root Cause

Any HTTP endpoint that spawns subprocesses must validate the command before execution. The attack surface is the command name itself (not just arguments), because Bobsled Core CLI has many subcommands with different security implications.

## Solution

Hard-coded `ALLOWED_COMMANDS` Set in `lib/bobsled-cli.ts`:

```typescript
const ALLOWED_COMMANDS = new Set([
  'integrations',
  'extract',
  'load',
  'model',
  'pipeline',
  'setup',
  'runner',
  'examples',
  'login',
  'init',
  'pull',
  'validate',
  'plan',
  'apply',
  'ask',
  'sql',
  'get',
  'list',
  'create',
  'update',
  'delete',
  'describe',
]);

export function isAllowedCommand(command: string): boolean {
  return ALLOWED_COMMANDS.has(command);
}
```

The API route validates before spawning:

```typescript
export async function POST(request: NextRequest) {
  const { command, args } = await request.json();
  if (!isAllowedCommand(command)) {
    return NextResponse.json({ error: `Command not allowed: ${command}` }, { status: 403 });
  }
  // spawn subprocess...
}
```

Key design decisions:

- **Set for O(1) lookup** — No iteration, no regex, no string matching
- **Whitelist, not blacklist** — New commands are blocked by default until explicitly added
- **Validation at API boundary** — Not in the UI, not in the hook, at the server entry point
- **`child_process.spawn` with array args** — Never shell interpolation. Arguments are passed as an array, never concatenated into a shell string

## Prevention

1. **Never use `exec()` or template strings** for subprocess commands in web contexts
2. **Always validate at the API boundary** — Client-side validation is cosmetic, server-side is mandatory
3. **Whitelist approach** — New Bobsled Core commands must be explicitly added to `ALLOWED_COMMANDS`
4. **Review trigger** — Any change to `bobsled-cli.ts` or `api/command/route.ts` should trigger security review
5. **Consider per-command arg validation** — Future enhancement: validate allowed flags per command (e.g., `extract` should not accept `--output /etc/passwd`)

## Related Issues

- OWASP Command Injection (OS Command Injection)
- The Bobsled Core CLI itself has SSRF protections (`isPrivateHost()` in extractor) — defense in depth
- `BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS` is an intentional escape hatch for VPN-hosted APIs
