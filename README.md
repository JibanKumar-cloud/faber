# Faber

**An agentic AI coding assistant for your terminal.** Give it a task in plain English; it explores your repository, edits files with your approval, runs your tests, and remembers your project across sessions.

*Faber — Latin for craftsman. Yours lives at `faber`.*

```
$ faber "add input validation to the signup endpoint and cover it with tests"
  ⚙ trace_path (from=main, to=handleSignup)
  ⚙ read_file (path=app/routes/auth.ts)

Proposed change to app/routes/auth.ts:
@@ -12,6 +12,9 @@
+  if (!isEmail(req.body.email)) return res.status(400)...
Apply?   ↑/↓ then Enter
❯ Yes
  No
  Always this session

  ⚙ run_shell (command=npm test)
─ result ────────────────────────────
Added email/password validation to /signup, verified with 4 new passing tests.
─────────────────────────────────────
tokens: 31.2k in (78% cached) / 1.9k out · 7 calls
```

## Your first session (2 minutes)

```bash
cd your-project     # any repo — Faber works on the folder you're in
faber               # start the REPL (approval mode is on by default)
```

1. **Give it a real task** — `add a comment explaining what the main entry file does`
2. **Approve the diff** — arrow keys, Enter. Cursor starts on Yes; "Always this session" grants trust. Shell commands ask too.
3. **See the safety net** — `/history` lists every task with the files it touched.
4. **Undo it** — `/undo` reverts the task; changed your mind? `/redo` brings it back. Nothing is ever lost in either direction.
5. **Come back tomorrow** — `faber --resume` continues the conversation, or just ask *"what did we do last time?"* — it searches past sessions itself.

That loop — **task, approve, inspect, revert** — is the whole trust model. Everything else is detail.

## Why Faber

**It has a map, not just eyes.** The code graph stores call and import *edges*, incrementally updated in milliseconds. One ~50-token query (`trace_path(main, saveUser)` → `main → startServer → handleSignup → saveUser`) replaces reading thousands of tokens of files. `/map main` prints the call tree — the "trace it from main" ritual every programmer does, automated.

**It's honest about money.** Prompt caching marks the stable prefix of every request, so repeat loop iterations pay ~10% for tokens already sent. And after every task you see exactly what happened: `tokens: 31.2k in (78% cached) / 1.9k out · 7 calls`.

**Nothing is irreversible.** Every task is checkpointed before it touches a file. Undo is undoable. Approvals gate both edits *and* shell commands. Rejecting a change tells the model to change course, not retry.

**It remembers.** Facts, decisions, and gotchas persist per-project in SQLite. Sessions survive crashes (append-only JSONL). New sessions start with a digest of the last one, and the agent searches past conversations when you reference them.

**You can steer it mid-flight.** See it going the wrong way? Just type — `use TypeScript, not JavaScript` — and your guidance is injected at the next loop iteration. No cancelling, no wasted tokens.

## Upgrading from Codewright

Faber is Codewright renamed (the npm name was taken between build and release). Existing projects keep working untouched: an existing `.codewright/` state directory is adopted as-is, so memory, code graph, sessions, and usage history all survive. `CW_*` environment variables still work alongside the canonical `FABER_*` names. New projects get `.faber/`.

## Requirements & install

Node.js ≥ 22.5 (uses built-in `node:sqlite` — **zero native dependencies**; installs never fail on compilation). Two pure-JS runtime deps: `diff`, `picocolors`.

```bash
npm install -g faberwright
export ANTHROPIC_API_KEY=sk-ant-...       # add to ~/.zshrc to persist
faber                                     # you're in
```

Any OpenAI-compatible provider: `FABER_PROVIDER=openai`, `OPENAI_API_KEY`, `FABER_BASE_URL`, `FABER_MODEL`.

## Features

| | |
|---|---|
| **Streaming agent loop** | Text renders as generated, with a live heartbeat (`✳ Working… 14s`) that never interleaves with output and ends in `✳ Worked for 14s`. Plan → tool → observe → adjust, until done. Hard iteration cap. |
| **Code graph** | Symbols *and* call/import edges, incrementally maintained (only changed files re-parse). Agent tools: `who_calls` (blast radius), `calls_from` (dependencies), `trace_path` (workflow chain). A compact repo map of the most-connected symbols orients every task. Edges are static hints — dynamic dispatch/DI/events aren't captured; the agent reads code where precision matters. |
| **Approval by default** | Arrow-key menu on every file edit (colored diff) and every shell command. `--auto` / `/auto` / `FABER_APPROVAL=auto` opts into autonomy. |
| **Interactive choices** | Genuinely ambiguous request? The agent presents 2–4 options plus "Chat more about this instead" before writing code. |
| **Mid-task steering** | Type while it works; guidance is injected at the next loop boundary. If the model finishes while steering is queued, the task continues instead. Steering markers carry a per-task nonce, so hostile file contents can't impersonate you. |
| **Paste as chips** | Raw-mode composer: pasting a 50-line block renders only a chip — `[pasted #1 +50 lines]` — never the code itself, while the full text is expanded into the message on Enter. Paste the same block again to expand it visibly. Paste, type, paste again: one submission. Full line editing: arrows, Home/End, forward-delete, Ctrl-A/E/K/U, Up/Down history; long drafts wrap across rows with exact cursor tracking — backspace and arrows travel across wrap boundaries. Chips are atomic — one arrow step, one backspace.  Works at the prompt and while steering. |
| **Reversible history** | `/history` lists tasks with files touched; `/restore <id>` jumps anywhere; `/undo` / `/redo` — restores are never destructive. |
| **Git-aware** | Warns about uncommitted changes at startup. Optional `FABER_GIT=commit`: one commit per completed *task* (never per edit). The agent never commits by default. |
| **Two-layer memory** | Short-term: token-budgeted window, auto-summarized past 60k (tool pairs never split). Long-term: SQLite+FTS5 facts/decisions/gotchas + per-file notes, with full lifecycle (`/forget`, `/archive`, `/prune`). |
| **Sessions** | Crash-safe JSONL transcripts; `--resume`; last-session digest injected at startup; `recall_sessions` keyword search across history. |
| **Prompt caching** | Cache breakpoints on system prompt, tools, and sliding conversation history. Typical tasks: 60–90% of input from cache. |
| **Output discipline** | Research-informed brevity (Chain-of-Draft style): short prose answers, shorthand inter-tool notes, no postamble — with an explicit exception that code correctness and completeness are never sacrificed for token count. `/verbose` toggles full-depth explanations. `FABER_WEAK_MODEL` routes internal summarization (compaction, digests) to a cheap model. |
| **Token transparency** | Per-task footer with cache rate. Set `FABER_PRICE_IN` / `FABER_PRICE_OUT` ($/Mtok) for cost estimates. |
| **Usage dashboard** | `/usage` shows a persistent ledger: tasks, tokens, cache rate, cost, and cache *savings* — for this session, today, and all time, plus totals across every project on the machine. Records live in `.faber/usage.db` per project and survive restarts. |
| **Error recovery** | Transient API errors: backoff + jitter, honors Retry-After. Tool errors return to the model to self-correct. Identical call failing twice → warning; three times → clean abort. Ctrl-C aborts streams *and* running commands; checkpoints survive. |
| **Safety rails** | Symlink-resolved path jail, shell denylist, timeouts, output truncation, atomic writes (temp+rename), stale-edit guard. Guardrails, not a sandbox — use a container for untrusted code. |

## Commands

```
/index              rebuild the code graph (symbols + call edges)
/map <symbol>       print the call tree from any entry point
/memory [archived]  long-term memories (+ file notes)
/forget <id>        delete a memory        /archive|/unarchive <id>
/prune <days>       archive memories older than N days
/compact            force-summarize the conversation now
/sessions           list saved sessions      (resume: faber --resume)
/history            task checkpoints         /restore <id>
/undo  /redo        revert last task / bring it back
/ask  /auto         toggle approval mode
/clear  /help  /exit
```

Flags: `faber [task] [--workspace|-w <dir>] [--resume] [--ask|--auto] [--version]`

## Configuration

| Env var | Effect (default) |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | credentials |
| `FABER_PROVIDER` | `anthropic` \| `openai` (anthropic) |
| `FABER_MODEL`, `FABER_BASE_URL` | model + endpoint overrides |
| `FABER_APPROVAL` | `ask` \| `auto` (ask) |
| `FABER_GIT` | `commit` = one commit per task (off) |
| `FABER_PRICE_IN`, `FABER_PRICE_OUT` | $/Mtok → cost estimate in footer |
| `FABER_WEAK_MODEL` | cheap model for internal summarization (e.g. a Haiku-class model) |
| `FABER_MAX_ITERATIONS` | loop cap (40) |
| `FABER_CONTEXT_BUDGET` | compaction threshold, tokens (60000) |
| `FABER_SHELL_TIMEOUT` | ms (120000) |

Per-project overrides: `.faber/config.json`.

**Commit protection is automatic:** on startup in a git repo, Faber writes `.faber/` into `.git/info/exclude` (a local-only ignore — no diff, nothing committed), so state can never reach GitHub even if you forget `.gitignore`. If `.faber/` was already committed in the past, you get a loud red warning with the exact `git rm --cached` fix. Sessions and checkpoints can contain file contents — this protection exists so they never leak with production code. Teams: also add `.faber/` to the shared `.gitignore` so teammates are covered from their first run.

## Failure-mode matrix

| Failure | Behavior |
|---|---|
| API 429/5xx/network drop | retry with backoff+jitter; Retry-After honored; clear fatal after N attempts |
| Bad API key | immediate fatal naming the env var to set |
| Malformed tool JSON in stream | stream retried |
| Unknown tool / invalid arguments | corrective message returned; model adjusts |
| Identical call keeps failing | warning at 2, abort at 3 (checkpoints kept) |
| Command hangs | SIGTERM at timeout, SIGKILL 3s later |
| Ctrl-C mid-task | stream + child processes aborted; `/undo` still works |
| Process killed mid-file-write | atomic rename → file is old or new, never half-written |
| Process killed mid-session-write | JSONL loses ≤1 line; skipped on resume |
| File changed between diff preview and apply | apply rejected; model told to re-read |
| Ambiguous / missing edit target | rejected with guidance |
| Path escapes workspace (incl. symlinks) | blocked |
| Context overflow | auto-summarized; tool pairs kept intact |
| User rejects a change | model told not to retry; asks instead |
| Older `.faber` databases | schema migrated automatically |

## Testing

```bash
npm test          # 30 offline tests — no API key needed
node selftest.mjs # installation self-check + live agent verification (report file to share)
```

The suite covers the awkward stuff on purpose: undo/redo round-trips, checkpoint ID collisions within one millisecond, session files torn mid-write, stopword-polluted recall queries, cyclic call graphs, CRLF + emoji surgical edits, mid-stream cancellation, steering-message role alternation, paste markers split across stream chunks, multi-paste + typed-text composition, doom-loop abort — plus three end-to-end tests that drive the real agent loop (and one that drives the real CLI binary) against a mock streaming API server.

CI (`.github/workflows/ci.yml`): Ubuntu / macOS / Windows × Node 22 / 24 — tests, build, and CLI smoke on every push.

## Architecture

```
CLI/REPL (index.ts)   streaming render · arrow-key approvals · steering capture · Ctrl-C cancel
   │
Agent loop (agent.ts) recall memory + repo map → [LLM ⇄ tools] → verify → summarize
   │                  doom-loop breaker · iteration cap · compaction · session log · steering drain
   ├─ LLM (llm.ts)            Anthropic + OpenAI-compatible · SSE streaming · prompt caching · usage · retry
   ├─ Tools (tools/)          validated dispatch · mutations staged as diffs · shell gated by approval
   ├─ Graph (indexer.ts)      symbols + call/import edges · incremental · who_calls / trace_path / map
   ├─ Memory (memory/)        shortTerm (window+compaction) · longTerm (SQLite+FTS) · sessions (JSONL)
   └─ Checkpoints             snapshot-before-write · /history · reversible restore

All state in <repo>/.faber/   (memory.db, index.db, sessions/, checkpoints/)
```

## Roadmap

Tree-sitter edges (compiler-grade graph) · Graphify `graph.json` integration · stale tool-result eviction · secret redaction in session logs · global user profile (~/.faber) · embedding recall · branch-per-task git mode · VS Code extension on this core.

## License

Apache-2.0 — see LICENSE.
