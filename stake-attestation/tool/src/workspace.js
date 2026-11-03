// A claim's files: <claim-dir>/.verdikta-claim/, mode 0700, each file 0600. Nothing here trusts what it
// finds: a read measures the file (regular, this user's, no group or world bits, no link), and a file that
// fails is a refusal, not a repair, because whoever could read it may already have. Writes are atomic and
// durable: an exclusive temp file, fsync, rename, fsync of the folder. So a crash leaves either the old file
// or the new one, and what the tool has said is saved is on the disk before anything is sent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fail } from './errors.js';

export const STATE_DIR = '.verdikta-claim';
const TMP = /\.tmp-[0-9a-f-]+$/;
const FLAGS = fs.constants;

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

function wrongOwner(stat) {
  const me = uid();
  return me !== null && stat.uid !== me;
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, FLAGS.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function openWorkspace(claimDir) {
  const dir = path.join(claimDir, STATE_DIR);
  const pathOf = (name) => path.join(dir, name);

  function assertDirPrivate() {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw fail('FILE_ERROR', STATE_DIR);
    }
    if (!st.isDirectory() || wrongOwner(st) || (st.mode & 0o077) !== 0) throw fail('FILE_NOT_PRIVATE', STATE_DIR);
    return true;
  }

  function ensureDir() {
    if (assertDirPrivate()) {
      if (!fs.existsSync(pathOf('.gitignore'))) writePrivate('.gitignore', Buffer.from('*\n'));
      return;
    }
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      if (err.code === 'EEXIST') {
        assertDirPrivate();
        return;
      }
      throw fail('FILE_ERROR', `${STATE_DIR} could not be made`);
    }
    assertDirPrivate();
    writePrivate('.gitignore', Buffer.from('*\n'));
    fsyncDir(claimDir);
  }

  function writePrivate(name, bytes) {
    const tmp = pathOf(`${name}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    let fd;
    try {
      fd = fs.openSync(tmp, FLAGS.O_WRONLY | FLAGS.O_CREAT | FLAGS.O_EXCL | FLAGS.O_NOFOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      // A write may take part of what it is given. All of it is on disk, measured, or nothing is saved.
      for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at);
      if (fs.fstatSync(fd).size !== bytes.length) throw new Error('short');
      fs.fsyncSync(fd);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw fail('FILE_ERROR', `${name} could not be written`);
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmp, pathOf(name));
      fsyncDir(dir);
    } catch {
      fs.rmSync(tmp, { force: true });
      throw fail('FILE_ERROR', `${name} could not be saved`);
    }
    measure(name);
  }

  /** A file's bytes, once it has been measured private. @returns {Buffer|null} null when absent */
  function readOptional(name) {
    let fd;
    try {
      fd = fs.openSync(pathOf(name), FLAGS.O_RDONLY | FLAGS.O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP' || err.code === 'EMLINK') throw fail('FILE_NOT_PRIVATE', name);
      throw fail('FILE_ERROR', `${name} could not be read`);
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || wrongOwner(st) || (st.mode & 0o077) !== 0) throw fail('FILE_NOT_PRIVATE', name);
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  function read(name) {
    const bytes = readOptional(name);
    if (bytes === null) throw fail('FILE_MISSING', name);
    return bytes;
  }

  /** The file is on disk now, regular, this user's, 0600 or tighter. */
  function measure(name) {
    let st;
    try {
      st = fs.lstatSync(pathOf(name));
    } catch {
      throw fail('FILE_MISSING', name);
    }
    if (!st.isFile() || wrongOwner(st) || (st.mode & 0o077) !== 0) throw fail('FILE_NOT_PRIVATE', name);
  }

  function loadState() {
    const bytes = readOptional('state.json');
    if (bytes === null) return null;
    let state;
    try {
      state = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fail('STATE_INVALID');
    }
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1) throw fail('STATE_INVALID');
    return state;
  }

  function saveState(state) {
    writePrivate('state.json', Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }

  function removeTemps() {
    for (const name of fs.readdirSync(dir)) {
      if (TMP.test(name)) fs.rmSync(pathOf(name), { force: true });
    }
  }

  // A holder's own file, named by its pid: `lock.<pid>.<random>`. Created before the others are read, so of two runs
  // that overlap at least one sees the other, and refuses (both may: run again). Nobody removes a file whose process
  // is alive, so a live holder cannot lose its lock, whatever else is racing.
  function lockFiles() {
    return fs.readdirSync(dir).filter((name) => /^lock\.[0-9]+\.[0-9a-f]+$/.test(name));
  }

  function takeLock() {
    const mine = `lock.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.closeSync(fs.openSync(pathOf(mine), FLAGS.O_WRONLY | FLAGS.O_CREAT | FLAGS.O_EXCL | FLAGS.O_NOFOLLOW, 0o600));
    } catch {
      throw fail('FILE_ERROR', 'the lock could not be taken');
    }
    for (const other of lockFiles()) {
      if (other === mine) continue;
      const holder = Number.parseInt(other.split('.')[1], 10);
      let alive = true;
      try {
        process.kill(holder, 0);
      } catch (err) {
        alive = err.code !== 'ESRCH';
      }
      if (alive) {
        fs.rmSync(pathOf(mine), { force: true });
        throw fail('FOLDER_BUSY', `It is process ${holder}. If no such run exists, remove ${pathOf(other)}.`);
      }
      fs.rmSync(pathOf(other), { force: true }); // its holder died: a crash the tool resumes from
    }
    return mine;
  }

  /** Runs `fn` holding the folder. A dead process's lock does not block a resume. */
  async function withLock(fn) {
    ensureDir();
    const mine = takeLock();
    try {
      removeTemps();
      return await fn();
    } finally {
      fs.rmSync(pathOf(mine), { force: true });
    }
  }

  return {
    dir,
    claimDir,
    exists: () => assertDirPrivate(),
    write: writePrivate,
    read,
    readOptional,
    measure,
    loadState,
    saveState,
    withLock,
    /**
     * Sets aside what a first draw would replace. With no state file these are a prepare that died, or a state file
     * someone removed: nothing here can tell, and the keys of a sent commit cannot be made again, so nothing is deleted.
     */
    keepAside() {
      const stamp = `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
      for (const name of ['archive.zip', 'keys.json', 'ciphertext.age']) {
        if (readOptional(name) !== null) fs.renameSync(pathOf(name), pathOf(`${name}.set-aside-${stamp}`));
      }
      fsyncDir(dir);
    },
    /** Removes a prepared claim's files: the caller has checked nothing was signed. */
    removePrepared() {
      for (const name of ['archive.zip', 'keys.json', 'ciphertext.age', 'state.json']) fs.rmSync(pathOf(name), { force: true });
      fsyncDir(dir);
    },
  };
}
