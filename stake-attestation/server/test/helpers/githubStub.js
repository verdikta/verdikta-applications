// GitHub's Actions API on an ephemeral loopback port, for the listing flow's workflow backend: no test
// reaches GitHub. `script(inputs)` says what each dispatched run does: `statuses` (one per read of the
// run, the last repeating; a string is a status, an object is the run's fields), `artifacts`
// ({ name: zip bytes }), `approvals` (the review history), and `silent` (accepted, and no run appears).
import http from 'node:http';

const REPO = 'verdikta/site-builds';
const FILE = 'stake-attestation-site-build.yml';

export const SUCCESS = Object.freeze({ status: 'completed', conclusion: 'success' });
export const failed = (conclusion = 'failure') => ({ status: 'completed', conclusion });

export async function startGithubStub({ repo = REPO, file = FILE, answer = 204, script = () => ({ statuses: ['queued', 'in_progress'] }) } = {}) {
  const state = {
    runs: new Map(),
    next: 1000,
    dispatches: [],
    cancels: [],
    forceCancels: [],
    reads: [],
    blobRequests: [],
    /** path regex -> HTTP status: answered instead of the route */
    failing: [],
    /** the location an artifact's zip redirects to, instead of this server's */
    redirectTo: null,
    cancelStatus: 202,
  };
  const addRun = (fields = {}, plan = {}) => {
    const id = state.next;
    state.next += 1;
    const run = {
      id,
      display_title: 'unnamed',
      status: 'queued',
      conclusion: null,
      event: 'workflow_dispatch',
      head_branch: 'main',
      path: `.github/workflows/${file}`,
      html_url: `https://github.com/${repo}/actions/runs/${id}`,
      repository: { full_name: repo },
      ...fields,
    };
    state.runs.set(id, { run, statuses: [...(plan.statuses ?? [])], artifacts: plan.artifacts ?? {}, approvals: plan.approvals ?? [] });
    return run;
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      const p = url.pathname;
      state.reads.push({ method: req.method, path: p, authorization: req.headers.authorization ?? null, query: Object.fromEntries(url.searchParams) });
      const hit = state.failing.find((f) => f.path.test(p) && (!f.method || f.method === req.method));
      if (hit) {
        if (hit.status === 0) return req.socket.destroy();
        return json(res, hit.status, { message: `stub says ${hit.status}` });
      }
      const blob = /^\/blob\/([0-9]+)$/.exec(p);
      if (blob) {
        state.blobRequests.push({ authorization: req.headers.authorization ?? null });
        const bytes = state.blobs?.get(Number(blob[1]));
        if (!bytes) return json(res, 404, {});
        res.writeHead(200, { 'content-type': 'application/zip' });
        return res.end(bytes);
      }
      const base = `/repos/${repo}/actions`;
      if (!p.startsWith(base)) return json(res, 404, { message: 'not this repository' });
      const rest = p.slice(base.length);
      if (req.method === 'POST' && rest === `/workflows/${file}/dispatches`) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.dispatches.push({ body, authorization: req.headers.authorization ?? null, accept: req.headers.accept ?? null });
        const plan = script(body.inputs, state.dispatches.length) ?? {};
        const run = plan.silent ? null : addRun({ display_title: body.inputs['correlation-id'] }, plan);
        if (answer === 200 && run) return json(res, 200, { workflow_run_id: run.id, run_url: `${base}/runs/${run.id}`, html_url: run.html_url });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && rest === `/workflows/${file}/runs`) {
        const all = [...state.runs.values()].map((r) => r.run).reverse();
        const page = Number(url.searchParams.get('page') ?? 1);
        const per = Number(url.searchParams.get('per_page') ?? 30);
        return json(res, 200, { total_count: all.length, workflow_runs: all.slice((page - 1) * per, page * per) });
      }
      const one = /^\/runs\/([0-9]+)(\/[a-z_-]+)?$/.exec(rest);
      if (one) {
        const r = state.runs.get(Number(one[1]));
        if (!r) return json(res, 404, { message: 'Not Found' });
        if (req.method === 'POST' && (one[2] === '/cancel' || one[2] === '/force-cancel')) {
          (one[2] === '/cancel' ? state.cancels : state.forceCancels).push(r.run.id);
          if (state.cancelStatus !== 202) return json(res, state.cancelStatus, { message: 'cannot cancel' });
          r.statuses = [];
          Object.assign(r.run, { status: 'completed', conclusion: 'cancelled' });
          return json(res, 202, {});
        }
        if (req.method === 'GET' && !one[2]) {
          if (r.statuses.length) {
            const n = r.statuses.length > 1 ? r.statuses.shift() : r.statuses[0];
            Object.assign(r.run, typeof n === 'string' ? { status: n } : n);
          }
          return json(res, 200, r.run);
        }
        if (req.method === 'GET' && one[2] === '/artifacts') {
          const artifacts = Object.keys(r.artifacts).map((name, i) => ({ id: r.run.id * 100 + i, name, expired: false, size_in_bytes: r.artifacts[name].length }));
          state.blobs ??= new Map();
          for (const [i, name] of Object.keys(r.artifacts).entries()) state.blobs.set(r.run.id * 100 + i, r.artifacts[name]);
          return json(res, 200, { total_count: artifacts.length, artifacts });
        }
        if (req.method === 'GET' && one[2] === '/approvals') return json(res, 200, r.approvals);
      }
      const zip = /^\/artifacts\/([0-9]+)\/zip$/.exec(rest);
      if (zip && req.method === 'GET') {
        res.writeHead(302, { location: state.redirectTo ?? `http://127.0.0.1:${server.address().port}/blob/${zip[1]}` });
        return res.end();
      }
      return json(res, 404, { message: `no route ${req.method} ${p}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    repo,
    file,
    state,
    addRun,
    run: (id) => state.runs.get(id)?.run,
    failWith: (path, status, method) => state.failing.push({ path, status, method }),
    heal: () => { state.failing.length = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
