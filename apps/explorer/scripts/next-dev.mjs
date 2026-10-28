import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CommandError } from '@bobsled-inc/protocol';

export const DEFAULT_PORT = 3333;
export const DEFAULT_HOSTNAME = '127.0.0.1';
const MAX_PORT_SCAN_ATTEMPTS = 25;

function writeLine(message) {
  process.stderr.write(`${message}\n`);
}

function parsePortValue(rawValue, source) {
  const port = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CommandError(
      `Invalid ${source} port "${rawValue}". Expected an integer between 1 and 65535.`,
      2
    );
  }

  return port;
}

export function parseCliArgs(argv) {
  const forwardedArgs = [];
  let explicitPort;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      continue;
    }

    if (arg === '--port' || arg === '-p') {
      const rawValue = argv[index + 1];

      if (rawValue === undefined) {
        throw new CommandError(`Missing value for ${arg}.`, 2);
      }

      explicitPort = parsePortValue(rawValue, 'CLI');
      index += 1;
      continue;
    }

    if (arg.startsWith('--port=')) {
      explicitPort = parsePortValue(arg.slice('--port='.length), 'CLI');
      continue;
    }

    forwardedArgs.push(arg);
  }

  return { explicitPort, forwardedArgs };
}

function parseHostnameValue(rawValue, source) {
  if (!rawValue) {
    throw new CommandError(`Missing value for ${source}.`, 2);
  }

  if (rawValue.startsWith('-')) {
    throw new CommandError(`Missing value for ${source}.`, 2);
  }

  if (rawValue !== '127.0.0.1' && rawValue !== '::1') {
    throw new CommandError('Explorer is local-only; use a loopback address (127.0.0.1 or ::1).', 2);
  }

  return rawValue;
}

export function resolveRequestedHostname(forwardedArgs, fallback = DEFAULT_HOSTNAME) {
  let hostname = parseHostnameValue(fallback, 'hostname');

  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const arg = forwardedArgs[index];

    if (arg === '-H' || arg === '--hostname') {
      hostname = parseHostnameValue(forwardedArgs[index + 1], arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('-H=')) {
      hostname = parseHostnameValue(arg.slice(3), '-H');
      continue;
    }

    if (arg.startsWith('--hostname=')) {
      hostname = parseHostnameValue(arg.slice('--hostname='.length), '--hostname');
    }
  }

  return hostname;
}

export function isPortAvailable(port, hostname = DEFAULT_HOSTNAME) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen({ port, host: hostname });
  });
}

export async function findAvailablePort(startPort, isPortAvailableFn = isPortAvailable) {
  for (let offset = 0; offset <= MAX_PORT_SCAN_ATTEMPTS; offset += 1) {
    const candidatePort = startPort + offset;

    if (candidatePort > 65_535) {
      break;
    }

    if (await isPortAvailableFn(candidatePort)) {
      return candidatePort;
    }
  }

  throw new CommandError(
    `Could not find an open port between ${startPort} and ${Math.min(startPort + MAX_PORT_SCAN_ATTEMPTS, 65_535)}.`,
    1
  );
}

export async function resolveDevPort(argv, envPort, isPortAvailableFn = isPortAvailable) {
  const { explicitPort, forwardedArgs } = parseCliArgs(argv);
  const hostname = resolveRequestedHostname(forwardedArgs);
  const requestedPort = explicitPort ?? (envPort ? parsePortValue(envPort, 'PORT') : DEFAULT_PORT);
  const shouldFallback = explicitPort === undefined && envPort === undefined;
  const port = shouldFallback
    ? await findAvailablePort(requestedPort, (candidatePort) =>
        isPortAvailableFn(candidatePort, hostname)
      )
    : requestedPort;

  return {
    forwardedArgs,
    hostname,
    port,
    requestedPort,
    shouldFallback,
  };
}

function forwardedArgsIncludeHost(forwardedArgs) {
  return forwardedArgs.some(
    (arg) =>
      arg === '-H' || arg === '--hostname' || arg.startsWith('-H=') || arg.startsWith('--hostname=')
  );
}

export function createNextArgs(port, forwardedArgs, hostname = DEFAULT_HOSTNAME) {
  const requestedHostname = resolveRequestedHostname(forwardedArgs, hostname);
  const baseArgs = ['dev', '--port', String(port)];
  if (!forwardedArgsIncludeHost(forwardedArgs)) {
    baseArgs.push('-H', requestedHostname);
  }
  return [...baseArgs, ...forwardedArgs];
}

export async function run() {
  let resolved;

  try {
    resolved = await resolveDevPort(process.argv.slice(2), process.env.PORT);
  } catch (error) {
    writeLine(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    return;
  }

  if (resolved.shouldFallback && resolved.port !== resolved.requestedPort) {
    writeLine(
      `Port ${resolved.requestedPort} is already in use. Starting explorer on http://localhost:${resolved.port} instead.`
    );
    writeLine('Pass `-- --port <port>` to pin a specific dev port.');
  }

  const child = spawn('next', createNextArgs(resolved.port, resolved.forwardedArgs), {
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.once('error', (error) => {
    writeLine(error.message);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
