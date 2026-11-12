// The deploy kit's files, read for the checks that hold the kit to its rules and for the client's CSP test (node P23;
// stake-attestation/deploy/, README "Running the site"). The headers live in one include file that nginx loads; the
// client's test applies exactly its headers to the built client, through parseHeaderInclude, so the two cannot drift.
// Each reader refuses what it cannot read exactly, rather than read less than nginx or systemd would.

const HEADER_LINE = /^add_header\s+([A-Za-z][A-Za-z0-9-]*)\s+"([^"\\$]*)"(\s+always)?\s*;\s*(?:#.*)?$/;

/**
 * The header include: blank lines, comment lines and `add_header Name "value" [always];`, one to a line.
 * @param {string} text
 * @returns {{ name: string, value: string, always: boolean }[]}
 */
export function parseHeaderInclude(text) {
  const out = [];
  const seen = new Set();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = HEADER_LINE.exec(line);
    if (!m) throw new Error(`header include, line ${i + 1}: not add_header Name "value" [always]; with no variable or escape: ${line}`);
    const key = m[1].toLowerCase();
    if (seen.has(key)) throw new Error(`header include, line ${i + 1}: ${m[1]} is set twice`);
    seen.add(key);
    out.push({ name: m[1], value: m[2], always: Boolean(m[3]) });
  });
  return out;
}

/**
 * A Content-Security-Policy's directives, in order, each with its sources.
 * @param {string} policy
 * @returns {[string, string[]][]}
 */
export function parseCsp(policy) {
  const out = [];
  const seen = new Set();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const directive = name.toLowerCase();
    if (seen.has(directive)) throw new Error(`CSP: ${directive} is set twice`);
    seen.add(directive);
    out.push([directive, sources]);
  }
  return out;
}

/** @param {[string, string[]][]} directives */
export function serializeCsp(directives) {
  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
}

/**
 * The one change the client's CSP test makes to the policy: connect-src's off-origin sources, each named in `map`,
 * become this stack's stand-ins. It refuses a connect-src that holds anything but 'self' and exactly those origins, so
 * a source added to the include file is a source the test has to account for.
 * @param {string} policy
 * @param {Record<string, string>} map - production origin -> the stand-in's origin
 * @returns {string}
 */
export function mapConnectSources(policy, map) {
  const directives = parseCsp(policy);
  const connect = directives.find(([name]) => name === 'connect-src');
  if (!connect) throw new Error('CSP: no connect-src');
  const [, sources] = connect;
  if (!sources.includes("'self'")) throw new Error("CSP: connect-src does not name 'self', the site's own /api");
  for (const s of sources) {
    if (s !== "'self'" && !Object.hasOwn(map, s)) throw new Error(`CSP: connect-src names ${s}, which the test cannot stand in for`);
  }
  for (const from of Object.keys(map)) if (!sources.includes(from)) throw new Error(`CSP: connect-src does not name ${from}`);
  connect[1] = sources.map((s) => (s === "'self'" ? s : map[s]));
  return serializeCsp(directives);
}

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * An environment file as systemd's EnvironmentFile reads it, kept to the plain part of that: NAME=value lines,
 * comments on lines of their own. A quote (systemd would strip it) and a trailing comment (systemd would keep it, as
 * part of the value) are refused.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvFile(text) {
  const out = new Map();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = ENV_LINE.exec(line);
    if (!m) throw new Error(`env file, line ${i + 1}: not NAME=value: ${line}`);
    const [, name, value] = m;
    if (/["'\\]/.test(value)) throw new Error(`env file, line ${i + 1}: ${name}: no quote or escape (systemd strips them)`);
    if (/\s#/.test(value)) throw new Error(`env file, line ${i + 1}: ${name}: a trailing comment would become part of the value`);
    if (out.has(name)) throw new Error(`env file, line ${i + 1}: ${name} is set twice`);
    out.set(name, value);
  });
  return out;
}

/**
 * An nginx config as a tree: each directive's name and arguments, and its block when it has one. Comments, single
 * and double quotes are read as nginx reads them; nothing is resolved (an include stays a directive).
 * @param {string} text
 * @returns {{ name: string, args: string[], block?: object[] }[]}
 */
export function parseNginx(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') line += 1;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '{' || c === '}' || c === ';') {
      tokens.push({ t: c, line });
      i += 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let word = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) j += 1;
        if (text[j] === '\n') line += 1;
        word += text[j];
        j += 1;
      }
      if (j >= text.length) throw new Error(`nginx: unclosed quote, line ${line}`);
      tokens.push({ t: 'word', v: word, line });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s{};#"']/.test(text[j])) j += 1;
      tokens.push({ t: 'word', v: text.slice(i, j), line });
      i = j;
    }
  }
  let at = 0;
  const block = (depth) => {
    const out = [];
    let words = [];
    while (at < tokens.length) {
      const tok = tokens[at++];
      if (tok.t === 'word') {
        words.push(tok.v);
      } else if (tok.t === ';') {
        if (!words.length) throw new Error(`nginx: an empty directive, line ${tok.line}`);
        out.push({ name: words[0], args: words.slice(1) });
        words = [];
      } else if (tok.t === '{') {
        if (!words.length) throw new Error(`nginx: a block with no directive, line ${tok.line}`);
        out.push({ name: words[0], args: words.slice(1), block: block(depth + 1) });
        words = [];
      } else {
        if (depth === 0) throw new Error(`nginx: unexpected } on line ${tok.line}`);
        if (words.length) throw new Error(`nginx: a directive before line ${tok.line} has no ;`);
        return out;
      }
    }
    if (words.length) throw new Error(`nginx: the last directive has no ; (${words.join(' ')})`);
    if (depth > 0) throw new Error('nginx: an unclosed block');
    return out;
  };
  return block(0);
}
