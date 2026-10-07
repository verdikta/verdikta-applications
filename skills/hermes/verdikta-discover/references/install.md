# Install and deploy the preview

**Running Hermes Agent?** The ClawHub release is written for OpenClaw. Its SKILL.md names OpenClaw's fetch tool (`web_fetch`), which Hermes does not have, and Hermes' skill index shows only the first 57 characters of a description. Hermes' skills hub also lists ClawHub skills. If your installed SKILL.md names `web_fetch` in its reading rules, replace it with the Hermes copy, which is verified on Hermes (section "Hermes Agent" below):

```bash
hermes skills uninstall verdikta-discover
hermes skills install verdikta/verdikta-applications/skills/hermes/verdikta-discover
```

Obtain the complete [skill directory](https://github.com/verdikta/verdikta-applications/tree/main/skills/verdikta-discover) and [entrypoint](https://raw.githubusercontent.com/verdikta/verdikta-applications/refs/heads/main/skills/verdikta-discover/SKILL.md) from main. Pin the commit you reviewed; branch URLs are mutable. The ClawHub release (`clawhub install verdikta-discover`) has the same files without `tests/`; the test and evaluation files this page names are in the repository. Copy the complete directory, or install the release, to the host runtime’s skill location and follow that runtime’s loader instructions. Native loading has been verified on OpenClaw 2026.8.33 (see `tests/EVALUATION_PROTOCOL.md`). On Hermes Agent the skill needs its own copy; it has been verified there with that copy for claim checks against linked sources (section "Hermes Agent" below; `tests/CONNECTED_DESIGN.md`, Hermes rounds 1 and 2). The review and real-world templates are measured on Hermes in round 3b (`tests/connected-gates-hermes3b.json`); until it passes, the copy is not called verified for them.

Host configuration. Primary posture: an agent with web fetch that follows the hard rules in `SKILL.md`, with no signer, no transactional skill, no wallet environment and read-only file tools. Reading task sources needs no owner approval step; every URL is screened first with `scripts/url-screen.mjs` (also `node scripts/screen.mjs url <url>`). The screens are pure functions: `screenUrl` (https only; no credentials, port, IP literal, internal hostname or shortener; no query string, secret-shaped value or task text in a URL the agent composed), `screenRedirect` (a final origin that differs from the requested one makes the source unavailable), `screenContent` (advisory heuristics for text that tries to instruct the agent) and `isPublicIp` (for a host to check what a name resolved to). They reduce risk and do not make a page trustworthy: a URL screen cannot see an injection inside a reputable page, and the content screen misses much of what a human would catch (see `tests/EVALUATION_PROTOCOL.md` for measured rates). The limits on what the agent can do (no secrets, no spending tools, no uploads) are the real control.

Where the runtime has a pre-call hook, run `screenUrl` there so a blocked URL is never fetched. OpenClaw's documentation describes a `before_tool_call` plugin hook that can return `{ block: true, blockReason }` for a `web_fetch` call, fail-closed and scoped per agent, and a built-in guard that blocks private and internal addresses. That hook has not been run on a live gateway for this skill, and OpenClaw's documentation says it cannot rewrite `web_fetch` results, so content screening stays advisory there. The safest option remains a dedicated discovery agent with no web fetch at all: on OpenClaw 2026.8 use `tools.allow: ["read"]` and a `skills` allowlist of `verdikta-discover` (example: `tests/openclaw/agent.patch.example.json`).

Executable preview: from this skill directory run `node scripts/preview.bundle.mjs examples/assessment.json`, or pipe the input to `node scripts/preview.bundle.mjs -`; add `--check` for the short summary an agent reads (decision, missing inputs, drafted items and the draft's SHA-256). The bundle carries its dependencies and templates, so it needs only Node 20.18+: no install, no network, no other file. Every agent returns its assessment input, whether or not it can run the script. The website's work-order import derives the draft from that input with the same code, and the SHA-256 it shows is that of the text the script prints for the same input, the file the onboarding binder takes. Both refuse a draft that differs from a fresh derivation. `scripts/preview.mjs` is the same CLI from source (run `npm ci --ignore-scripts` first), and `npm run bundle` rebuilds the bundle and its third-party notices (`scripts/preview.bundle.NOTICES.txt`); `tests/bundle.test.mjs` fails when the committed bundle is stale. The input is a JSON assessment with `request`, `sharing_authorized`, an explicit `procurement_mode` (OPEN or TARGETED) for a draft and `targetHunter` for TARGETED. Optional fields: `local_sufficient`, `unsuitable_reason`, `handoff_requested`, `local_summary`, `market_context`, `network`. These are caller judgments, not model classifications by the script. No remote reads are implemented. Never treat example data as production work.

An agent that can run commands and also reads the web must still fetch pages with the host's fetch tool, never with shell network commands (`SKILL.md`, reading rule 5), and should run where a manipulated page cannot reach secrets, wallets or the host: for example an OpenClaw per-agent Docker sandbox (`agents.entries.<id>.sandbox` with `mode: "all"`, `workspaceAccess: "none"` and the default `network: "none"`, plus a sandbox tool policy that allows `read`, `exec` and `web_fetch`; the sandbox confines the shell and file tools, so confirm in a first turn that `web_fetch` is still offered), Verdikta Agents' coding sandbox, or Hermes' Docker terminal backend. The default OpenClaw image has no Node; use an image that has it. On OpenClaw the gateway process itself must be able to reach the Docker socket. If the same gateway also runs agents with unsandboxed host shells, that access reaches their shells too, and Docker access is root-equivalent: use a dedicated gateway or OpenClaw's SSH sandbox backend there instead. The preview itself needs no network.

The skill works without Node: the agent then returns the assessment input. For development and tests, use Node 20.18+ and run `npm ci --ignore-scripts` inside the skill directory. The test suite (`npm test`) also imports the bounty server's rubric validator, so run `npm ci --ignore-scripts` in `example-bounty-program/server` first when testing from a fresh clone. The permission-isolated tests also support Node 20.18+, using its experimental permission flag.

For the website, use Node 20.19+ or 22.12+ as required by Vite. Run `npm ci --ignore-scripts` in `skills/verdikta-discover` before the client build and browser tests, then run `npm ci --ignore-scripts` inside `example-bounty-program/client`. The client directly pins AJV 8 and formats; checksum hashing resolves from the skill’s own dependency tree, preserving ethers’ pinned crypto dependencies. A stale install may resolve AJV 6 and fail. BuyerPreview is loaded only on the Agents page. The Create Bounty page loads the same checking code (`scripts/work-order.mjs` and the validators) through a dynamic import, only when an owner imports a work-order draft, so ordinary use of that page compiles nothing. AJV runtime compilation requires a CSP allowing evaluation on any page that runs it; a strict-CSP deployment should precompile the validators before enabling the preview or the import. The import reads the file in the browser, sends nothing, and the owner still reviews every field, chooses the jury and signs with their own wallet.

## Recommended: an always-on pointer for agents with web access

An agent opens a skill only when it decides the task matches, and connected agents skipped this one in about 40% of claim checks against a linked page. A skipped skill means none of its source rules apply. Adding these lines to the agent's always-loaded instructions (on OpenClaw, the workspace `AGENTS.md`) made the agent open the skill first in 9 of 9 evaluated sessions (`tests/CONNECTED_DESIGN.md`, round 10):

The pointer below covers claim and fact checks. On OpenClaw, whose skills index carries the whole description, the skill also opened in 36 of 39 review and real-world sessions without a pointer for them (round 11). On Hermes it did not (Hermes round 3: 0 of 16 sessions without a URL), so the Hermes pointer in the section below carries a second part for outside work of any kind.

```markdown
## Checking claims or facts against linked sources

- Before fetching any page for a task that checks claims or looks up facts from linked or approved sources, open the `verdikta-discover` skill and follow it.
- Fetch pages only with `web_fetch`, never with curl, wget, a script, or a browse or search tool.
- After each fetch, compare the final URL with the one you asked for. A different host makes that source unavailable for the whole conversation: do not answer from it, even if you still have its text. If the owner has been told this and explicitly asks you to use it anyway, label every answer with the host it came from. Never call such an answer verified, and never put it in an assessment input.
```

## Hermes Agent

On Hermes, use the Hermes copy, `skills/hermes/verdikta-discover`, not the ClawHub release. It is generated from this skill by `skills/hermes/build-verdikta-discover.mjs`, and its SKILL.md differs only in its frontmatter and in the fetch tool that reading rules 5 and 7 name:

- **The description.** Hermes' skill index shows only the first 57 characters of a description, so the copy's starts with "Verify claims against linked pages, or scope outside work".
- **The fetch tool.** Hermes has no `web_fetch`. Its `web_extract` can report the URL it was asked for rather than the final one: its keyless vendors differ and fail over between each other, so a redirect can be hidden. The copy names `browser_navigate`, whose result's `url` is the final URL, and names `web_extract` and `web_search` as tools that can hide it.

Install it from the repository (Hermes' install-time scanner rates it safe), or copy that folder into `~/.hermes/skills/verdikta-discover/`:

```bash
hermes skills install verdikta/verdikta-applications/skills/hermes/verdikta-discover
```

Evaluation (`tests/CONNECTED_DESIGN.md`, Hermes rounds 1 and 2):
- **Setup.** Hermes main `85db7c3a`, gpt-5.6-terra, the configuration below and the pointer below.
- **Scope.** Verified for those cases.
- **Round 2** passed every pre-registered gate on 9 fresh sessions:
  - the skill was opened first in 6 of 6 claim checks against a linked page;
  - the redirect was handled in 6 of 6;
  - answers given at the owner's insistence were labelled in 3 of 3;
  - there were no verdicts from the unavailable source;
  - every returned input was fundable;
  - no agent fetched with `web_extract`, `web_search` or the shell, and none wrote a skill, memory or cron entry.
- **Round 1** failed only a strict "no file written" rule. Round 2's rule allows writes inside the session sandbox, and 2 of its 9 sessions wrote their own input there (see the Docker notes below).

Host configuration, in `~/.hermes/config.yaml`:

- `browser.backend: off`, plus `hermes pm install agent-browser`, so that the built-in browser tools, `browser_navigate` among them, are offered.
- **With the OpenAI Codex provider,** Hermes may switch web search to OpenAI's server-side tool. Its page opens are not recorded in Hermes' session store, and it cannot extract a page. Set `web.search_backend` and `web.extract_backend` to a client-side backend; the keyless `keenable` works.
- `skills.write_approval: true`. Hermes' chat prompt asks the agent to patch a skill it finds lacking; with approval on, such a patch is held for review instead.
- **`delegate_task` and coding-agent skills.** Asked for an outside review without a pointer for it, Hermes agents delegated the review to a Hermes sub-agent, or looked for Claude Code, Codex or OpenCode CLIs, and told the owner an independent review was in progress; one did so with a confidential excerpt (Hermes round 3). A sub-agent is the agent's own work, never outside or independent work. The pointer's second part says so; the skill's triage still decides what goes out.
- **With the Docker terminal backend:**
  - Keep `terminal.container_persistent: true`. The ephemeral mode mounts an empty `/home`, and Hermes' in-sandbox browser then fails to start.
  - The agent is shown the skill's host path, which does not exist in the sandbox. Mount the skills folder read-only at that same path, for example `terminal.docker_volumes: ["/home/<user>/.hermes/skills:/home/<user>/.hermes/skills:ro"]`.
  - A host mount turns Hermes' command guards back on. The preview check on standard input (`node .../preview.bundle.mjs --check - <<'JSON'`) then matches the rule "script execution via heredoc": approve it when asked, or list that rule in `command_allowlist`.
  - Piping the input instead (`printf '<json>' | node ...`) is held by Hermes' Tirith scanner (`tirith:pipe_to_interpreter`), which `command_allowlist` cannot exempt. Its advice is to write the content to a file first, and agents then save their assessment input as a file inside the sandbox and check that file.
- **Scripted or evaluation turns** should go through the gateway (for example its loopback API server), not `hermes -z`: one-shot runs get a weaker skill-loading prompt.

The always-on pointer goes in the `AGENTS.md` that gateway sessions load: the one in `terminal.cwd`, or in the home directory when that is unset. Its text is the pointer above with the fetch tool changed:

```markdown
## Checking claims or facts against linked sources

- Before fetching any page for a task that checks claims or looks up facts from linked or approved sources, open the `verdikta-discover` skill and follow it.
- Fetch pages only with `browser_navigate`, never with curl, wget, a script, `web_extract`, or a search tool.
- After each fetch, compare the final URL with the one you asked for. A different host makes that source unavailable for the whole conversation: do not answer from it, even if you still have its text. If the owner has been told this and explicitly asks you to use it anyway, label every answer with the host it came from. Never call such an answer verified, and never put it in an assessment input.

## Outside work of any kind

- Before commissioning, delegating or declining outside work of any kind (an outside or independent review, a task a person performs at a place or remotely, a batch too large to run yourself), open the `verdikta-discover` skill and follow it, even when the task names no page to fetch.
- A sub-agent, a delegated task or a coding-agent skill is not an independent reviewer: never present its work as outside or independent, and never pass confidential, private or unreleased material to one.
```
