import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const AUTH_STATE_FILE = 'auth-state.json';

interface OAuth2AuthStateEntry {
  refresh_token: string;
  updated_at: string;
}

interface AuthStateFile {
  oauth2?: Record<string, OAuth2AuthStateEntry>;
}

const stateCache = new Map<string, AuthStateFile>();

async function loadStateFile(filePath: string): Promise<AuthStateFile> {
  const cached = stateCache.get(filePath);
  if (cached) {
    return cached;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const emptyState: AuthStateFile = {};
      stateCache.set(filePath, emptyState);
      return emptyState;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupted auth state file ${filePath}: invalid JSON`);
  }

  const record =
    parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : Object.create(null);
  const oauth2 =
    record['oauth2'] && typeof record['oauth2'] === 'object'
      ? (record['oauth2'] as Record<string, OAuth2AuthStateEntry>)
      : undefined;

  const state: AuthStateFile = {
    ...(oauth2 ? { oauth2 } : {}),
  };
  stateCache.set(filePath, state);
  return state;
}

export class OAuth2AuthStateStore {
  private readonly filePath: string;

  constructor(private readonly stateDir: string) {
    this.filePath = path.join(stateDir, AUTH_STATE_FILE);
  }

  async get(key: string): Promise<OAuth2AuthStateEntry | undefined> {
    const state = await loadStateFile(this.filePath);
    return state.oauth2?.[key];
  }

  async save(key: string, refreshToken: string): Promise<void> {
    const state = await loadStateFile(this.filePath);
    const nextState: AuthStateFile = {
      ...state,
      oauth2: {
        ...(state.oauth2 ?? {}),
        [key]: {
          refresh_token: refreshToken,
          updated_at: new Date().toISOString(),
        },
      },
    };

    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(nextState, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tmpPath, this.filePath);
    stateCache.set(this.filePath, nextState);
  }
}
