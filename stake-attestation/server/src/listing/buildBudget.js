// The limits on builds that run on Verdikta's runners (node P15). A wallet costs nothing and a proof file costs a
// commit, so these are what bound the minutes a stranger can spend:
//
//   per wallet       attempts in the window, charged when the wallet has signed. A refused proof still costs its
//                    wallet an attempt, so bad requests from one wallet stop.
//   per repo owner   builds in the window per <host>/<owner>, charged once the proof stands (before that, the name
//                    proves nothing, and anyone could use up a project's allowance). Several wallets don't help;
//                    several git-host accounts do.
//   overall          builds in the window, whoever asks. This is what actually bounds the spend, and one stranger
//                    with enough accounts can use all of it: the limit stops the bill, not the denial of service.
//
// A build that started no run (a refused proof, GitHub's refusal) gives its overall place back. The counts live in
// a small file of their own, replaced atomically, so a restart forgets nothing. A file that can't be read or
// written refuses builds: a limit nobody can keep is no limit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_BUDGET_FILE = 'build-budget.json';

export class BuildLimitError extends Error {
  constructor(status, code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'BuildLimitError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function read(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return null;
  }
  try {
    const doc = JSON.parse(text);
    return Array.isArray(doc?.entries) && doc.entries.every((e) => e && typeof e.id === 'string' && Number.isSafeInteger(e.at)) ? doc.entries : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string} o.file
 * @param {{ perWallet: number, perRepoOwner: number, overall: number, windowMs: number }} o.limits
 * @param {() => number} [o.now]
 * @param {{ error: Function }} o.logger
 */
export function createBuildBudget({ file, limits, now = Date.now, logger }) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch { /* the write says so, and refuses */ }
  let entries = read(file);
  if (entries === null) logger.error(`the build limits' state (${BUILD_BUDGET_FILE}) cannot be read: no build starts until it is fixed or removed`);
  // reservations of this server's queued requests, which may wait longer than the window: they stay until their
  // build starts or they are given back. A restart loses those requests, so their entries then age out as usual.
  const waiting = new Set();
  const hours = Math.round(limits.windowMs / 3600000);
  const unavailable = () => new BuildLimitError(503, 'BUILD_BUDGET_UNAVAILABLE', 'the site cannot keep its build limits just now, so it starts no build; try again later');

  const current = () => {
    const from = now() - limits.windowMs;
    entries = entries.filter((e) => Math.max(e.at, e.startedAt ?? 0) >= from || waiting.has(e.id));
    return entries;
  };
  /** Whether the file now says what memory says. */
  function write() {
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ version: 1, entries }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      logger.error(`the build limits' state cannot be written (${err?.code ?? 'error'})`);
      return false;
    }
  }

  return {
    /**
     * A signed request's attempt, before it is queued.
     * @throws {BuildLimitError} MAKER_BUILD_LIMIT, BUILD_BUDGET_EXHAUSTED, BUILD_BUDGET_UNAVAILABLE
     */
    admit(id, maker) {
      if (entries === null) throw unavailable();
      const list = current();
      const from = now() - limits.windowMs;
      if (list.filter((e) => e.maker === maker && (e.at >= from || waiting.has(e.id))).length >= limits.perWallet) {
        throw new BuildLimitError(429, 'MAKER_BUILD_LIMIT', `this wallet has used its ${limits.perWallet} build attempts in ${hours} h; try again later`);
      }
      if (list.filter((e) => e.counted).length >= limits.overall) {
        throw new BuildLimitError(429, 'BUILD_BUDGET_EXHAUSTED', `the site has started its ${limits.overall} builds in ${hours} h; try again later`);
      }
      list.push({ id, at: now(), maker, owner: null, counted: true });
      if (!write()) {
        list.pop();
        throw unavailable();
      }
      waiting.add(id);
    },

    /**
     * The repository's owner, once the proof stands and before the run starts. For the owner and overall limits the
     * window counts from here; a wallet's attempt keeps the time it was made.
     * @throws {BuildLimitError} REPO_OWNER_BUILD_LIMIT, BUILD_BUDGET_UNAVAILABLE
     */
    chargeOwner(id, owner) {
      if (entries === null) throw unavailable();
      const list = current();
      if (list.filter((e) => e.counted && e.owner === owner).length >= limits.perRepoOwner) {
        throw new BuildLimitError(429, 'REPO_OWNER_BUILD_LIMIT', `this repository's owner has had its ${limits.perRepoOwner} builds in ${hours} h; try again later`);
      }
      const entry = list.find((e) => e.id === id);
      if (!entry) throw unavailable();
      entry.owner = owner;
      entry.startedAt = now();
      if (!write()) {
        entry.owner = null;
        delete entry.startedAt;
        throw unavailable();
      }
      waiting.delete(id);
    },

    /** No run started: its overall and owner places go back. The wallet's attempt stays spent. */
    release(id) {
      waiting.delete(id);
      const entry = entries?.find((e) => e.id === id);
      if (!entry) return;
      entry.counted = false;
      entry.owner = null;
      write();
    },

    /** Numbers only, for /api/status. */
    view() {
      return { windowMs: limits.windowMs, used: entries === null ? null : current().filter((e) => e.counted).length, overall: limits.overall };
    },
  };
}
