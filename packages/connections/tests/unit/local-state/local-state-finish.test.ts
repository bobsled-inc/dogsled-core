import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Generic test: an earlier folder name stands in, so it passes before and after the rename.
vi.mock('../../../src/local-state/legacy-names.js', () => ({
  LEGACY_LOCAL_STATE_DIRS: ['.legacy'],
  LEGACY_LOCAL_DATABASE_FILES: ['legacy.duckdb'],
}));
const failing = vi.hoisted(() => ({ file: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (failing.file && String(to).endsWith(failing.file)) throw new Error('EBUSY');
      return real.renameSync(from, to);
    },
  };
});

const { LOCAL_DATABASE_FILE, LOCAL_STATE_DIR, prepareLocalStateDir } =
  await import('../../../src/local-state/local-state-dir.js');

let root = '';
afterEach(() => {
  failing.file = '';
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a takeover whose finish fails', () => {
  it.each([LOCAL_DATABASE_FILE, 'config.yml'])(
    'moves everything back when %s cannot be put in place, and uses the earlier folder',
    async (file) => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-state-finish-')));
      fs.mkdirSync(path.join(root, '.legacy'));
      fs.writeFileSync(path.join(root, '.legacy/config.yml'), 'db: .legacy/legacy.duckdb\n');
      fs.writeFileSync(path.join(root, '.legacy/legacy.duckdb'), 'db');
      failing.file = file;
      const notices: string[] = [];
      const used = await prepareLocalStateDir(root, { notice: (m: string) => notices.push(m) });
      expect(used).toBe(path.join(root, '.legacy'));
      expect(fs.existsSync(path.join(root, LOCAL_STATE_DIR))).toBe(false);
      expect(fs.readdirSync(path.join(root, '.legacy')).sort()).toEqual(
        ['config.yml', 'legacy.duckdb'].sort()
      );
      expect(fs.readFileSync(path.join(root, '.legacy/config.yml'), 'utf8')).toBe(
        'db: .legacy/legacy.duckdb\n'
      );
      expect(notices).toEqual([expect.stringMatching(/using \.legacy\/ for this run/)]);
    }
  );
});
