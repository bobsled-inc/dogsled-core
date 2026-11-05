import { getCiphers } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { connectToValidatedHost } from '../../framework/core/index.js';
import { ExtractorConfigError } from '../errors.js';
import type { SftpChannel } from './sftp-listing.js';

export type SftpConnectionSettings = {
  host: string;
  port?: number;
  username: string;
  base_directory: string;
  legacy_algorithms?: boolean;
  keepalive_interval_seconds?: number;
  min_file_age_seconds?: number;
  read_concurrency?: number;
};

export type SftpAuthSettings = {
  type: string;
  password_env?: string;
  keyboard_interactive?: boolean;
  private_key_env?: string;
  private_key_path_env?: string;
  passphrase_env?: string;
  host_fingerprint?: string;
  known_hosts_path?: string;
};

type KeyboardPrompt = { prompt: string; echo?: boolean };

type Ssh2Client = {
  on(event: 'ready' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'keyboard-interactive',
    listener: (
      name: string,
      instructions: string,
      language: string,
      prompts: KeyboardPrompt[],
      finish: (answers: string[]) => void
    ) => void
  ): unknown;
  once(event: 'close', listener: () => void): unknown;
  connect(config: Record<string, unknown>): void;
  sftp(callback: (error: Error | undefined, channel: SftpChannel) => void): void;
  end(): void;
};

export type Ssh2Module = {
  Client: new () => Ssh2Client;
  utils: { parseKey(data: string, passphrase?: string): unknown };
};

export type SftpSession = { sftp: SftpChannel; close(): Promise<void> };

const CLOSE_TIMEOUT_MS = 5_000;
const MAX_KEYBOARD_ROUNDS = 5;

/**
 * Algorithms appended after ssh2's defaults when `legacy_algorithms` is set,
 * so a server that offers anything newer still negotiates it.
 */
const LEGACY_KEX = [
  'diffie-hellman-group14-sha1',
  'diffie-hellman-group-exchange-sha1',
  'diffie-hellman-group1-sha1',
];
const LEGACY_HOST_KEYS = ['ssh-dss'];
const LEGACY_CIPHERS: Record<string, string> = {
  'aes128-cbc': 'aes-128-cbc',
  'aes192-cbc': 'aes-192-cbc',
  'aes256-cbc': 'aes-256-cbc',
  '3des-cbc': 'des-ede3-cbc',
};

function readRequiredEnv(name: string | undefined, field: string): string {
  if (!name) {
    throw new ExtractorConfigError(`SFTP auth ${field} is required`);
  }
  const value = process.env[name];
  if (!value) {
    throw new ExtractorConfigError(`SFTP auth ${field} references missing env var ${name}`);
  }
  return value;
}

export function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

async function loadAllowedFingerprints(auth: SftpAuthSettings): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (auth.host_fingerprint) {
    allowed.add(normalizeFingerprint(auth.host_fingerprint));
  }
  if (auth.known_hosts_path) {
    const contents = await readFile(auth.known_hosts_path, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const sha256 = trimmed.match(/SHA256:([A-Za-z0-9+/=]+)/i);
      if (sha256?.[1]) {
        allowed.add(normalizeFingerprint(sha256[1]));
      }
    }
  }
  allowed.delete('');
  return allowed;
}

type SftpCredentials = { password?: string; privateKey?: string; passphrase?: string };

async function readCredentials(ssh2: Ssh2Module, auth: SftpAuthSettings): Promise<SftpCredentials> {
  if (auth.type === 'password') {
    return { password: readRequiredEnv(auth.password_env, 'password_env') };
  }
  if (auth.type !== 'private_key') {
    return {};
  }
  if (Boolean(auth.private_key_env) === Boolean(auth.private_key_path_env)) {
    throw new ExtractorConfigError(
      'SFTP private_key auth requires exactly one of private_key_env or private_key_path_env'
    );
  }
  const passphrase = auth.passphrase_env
    ? readRequiredEnv(auth.passphrase_env, 'passphrase_env')
    : undefined;
  const privateKey = auth.private_key_env
    ? readRequiredEnv(auth.private_key_env, 'private_key_env')
    : await readFile(readRequiredEnv(auth.private_key_path_env, 'private_key_path_env'), 'utf8');
  const parsed = ssh2.utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    throw new ExtractorConfigError(`SFTP auth private key could not be read: ${parsed.message}`);
  }
  return { privateKey, passphrase };
}

function legacyAlgorithms(): Record<string, { append: string[] }> {
  const available = new Set(getCiphers());
  return {
    kex: { append: LEGACY_KEX },
    serverHostKey: { append: LEGACY_HOST_KEYS },
    cipher: {
      append: Object.keys(LEGACY_CIPHERS).filter((name) => available.has(LEGACY_CIPHERS[name]!)),
    },
  };
}

function answerPasswordPrompts(client: Ssh2Client, password: string): void {
  let rounds = 0;
  client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
    rounds += 1;
    if (rounds > MAX_KEYBOARD_ROUNDS) {
      finish([]);
      return;
    }
    finish(prompts.map((prompt) => (prompt.echo ? '' : password)));
  });
}

function endClient(client: Ssh2Client, socket: { destroy(): void }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, CLOSE_TIMEOUT_MS);
    client.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    client.end();
  });
}

/**
 * Open an SFTP channel. Every credential is read and the private key is
 * parsed before the socket opens, so a configuration error never leaves an
 * open connection behind.
 */
export async function openSftpSession(
  ssh2: Ssh2Module,
  connection: SftpConnectionSettings,
  auth: SftpAuthSettings
): Promise<SftpSession> {
  const credentials = await readCredentials(ssh2, auth);
  const allowedFingerprints = await loadAllowedFingerprints(auth);
  if (allowedFingerprints.size === 0) {
    throw new ExtractorConfigError(
      'SFTP auth requires host_fingerprint or known_hosts_path with valid SHA256 entries'
    );
  }
  const socket = await connectToValidatedHost(connection.host, connection.port ?? 22);
  const client = new ssh2.Client();
  let closed = false;
  client.on('close', () => {
    closed = true;
  });
  const keyboardInteractive = auth.keyboard_interactive === true && credentials.password !== undefined;
  if (keyboardInteractive) {
    answerPasswordPrompts(client, credentials.password!);
  }
  try {
    const sftp = await new Promise<SftpChannel>((resolve, reject) => {
      client.on('ready', () => {
        client.sftp((err, channel) => (err ? reject(err) : resolve(channel)));
      });
      client.on('error', (error) => {
        socket.destroy();
        reject(error);
      });
      client.on('close', () => reject(new Error('SFTP connection closed before it was ready')));
      client.connect({
        sock: socket,
        username: connection.username,
        password: credentials.password,
        privateKey: credentials.privateKey,
        passphrase: credentials.passphrase,
        tryKeyboard: keyboardInteractive,
        hostHash: 'sha256',
        // ssh2 passes a hex SHA256 digest; SSH fingerprints are base64 (SHA256:<base64>).
        hostVerifier: (hash: string) =>
          allowedFingerprints.has(normalizeFingerprint(Buffer.from(hash, 'hex').toString('base64'))),
        ...(connection.legacy_algorithms ? { algorithms: legacyAlgorithms() } : {}),
        ...(connection.keepalive_interval_seconds
          ? { keepaliveInterval: Math.round(connection.keepalive_interval_seconds * 1000) }
          : {}),
      });
    });
    return {
      sftp,
      close: async () => {
        if (!closed) await endClient(client, socket);
      },
    };
  } catch (error) {
    client.end();
    socket.destroy();
    throw error;
  }
}
