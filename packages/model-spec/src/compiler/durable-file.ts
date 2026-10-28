/** Same-host file transactions. Network and multi-host file systems are not supported. */
import * as fs from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;

export function ensureStateDirectory(project: string): string {
  const root = fs.realpathSync(project);
  let directory = root;
  for (const segment of ['.dogsled', 'model-spec']) {
    const parent = directory;
    directory = path.join(parent, segment);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      throw new Error('State directory must remain inside the project');
    }
    syncDirectory(parent);
  }
  return directory;
}

export function readBoundedFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_STATE_FILE_BYTES) {
      throw new Error('State file exceeds its limit');
    }
    const buffer = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size) throw new Error('State file changed during read');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeDurableFile(file: string, value: string): void {
  if (Buffer.byteLength(value) > MAX_STATE_FILE_BYTES) {
    throw new Error('State file exceeds its limit');
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A lock is an atomic symlink with no partially written owner record. */
export function acquireFileOwnership(file: string): { assert(): void; release(): void } {
  const token = `${hostname()}:${process.pid}:${randomUUID()}`;
  const recovery = `${file}.recovery`;
  const exists = (name: string): boolean => {
    try {
      fs.lstatSync(name);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const claim = (name: string): void => fs.symlinkSync(token, name);
  const assert = (): void => {
    if (fs.readlinkSync(file) !== token || exists(recovery)) {
      throw new Error('State ownership lost');
    }
  };
  const release = (): void => {
    if (exists(file) && fs.readlinkSync(file) === token) fs.unlinkSync(file);
  };
  if (exists(recovery)) throw new Error('State lock recovery requires operator attention');
  try {
    claim(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let previous: string | undefined;
    try {
      previous = fs.readlinkSync(file);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    if (previous === undefined) {
      // The prior writer released between our failed claim and owner read.
      try {
        claim(file);
      } catch {
        throw new Error('State is owned by another writer');
      }
    } else {
      const prior = previous.split(':');
      if (prior.length !== 3 || prior[0] !== hostname() || !/^\d+$/.test(prior[1]!)) {
        throw new Error('State lock belongs to an unsupported host');
      }
      // Do not install a recovery marker over a live owner: that marker would
      // needlessly fence its in-flight transaction.
      try {
        process.kill(Number(prior[1]), 0);
        throw new Error('State is owned by another writer');
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure;
      }
      try {
        claim(recovery);
      } catch {
        throw new Error('State is owned by another writer');
      }
      try {
        if (fs.readlinkSync(file) !== previous) throw new Error('State is owned by another writer');
        fs.unlinkSync(file);
        claim(file);
      } finally {
        fs.unlinkSync(recovery);
      }
    }
  }
  try {
    assert();
  } catch (error) {
    release();
    throw error;
  }
  return { assert, release };
}
