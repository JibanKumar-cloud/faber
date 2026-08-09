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
cd your-project     # any repo; Faber works on the folder you're in
faber               # start the REPL (approval mode is on by default)
```

1. **Give it a real task.** Try `add a comment explaining what the main entry file does`
2. **Approve the diff** with the arrow keys and Enter. Cursor starts on Yes; "Always this session" grants trust. Shell commands ask too.
3. **See the safety net.** `/history` lists every task with the files it touched.
4. **Undo it.** `/undo` reverts the task, and if you change your mind changed your mind? `/redo` brings it back. Nothing is ever lost in either direction.
5. **Come back tomorrow.** `faber --resume` continues the conversation, or just ask *"what did we do last time?"* — it searches past sessions itself.

That loop of task, approve, inspect, revert is the whole trust model. Everything else is detail.

## Why Faber

**It has a map, not just eyes.** The code graph stores call and import *edges*, incrementally updated in milliseconds. One ~50-token query (`trace_path(main, saveUser)` → `main → startServer → handleSignup → saveUser`) replaces reading thousands of tokens of files. `/map main` prints the call tree — the "trace it from main" ritual every programmer does, automated.

**It's honest about money.** Prompt caching marks the stable prefix of every request, so repeat loop iterations pay ~10% for tokens already sent. And after every task you see exactly what happened: `tokens: 31.2k in (78% cached) / 1.9k out · 7 calls`.

**Nothing is irreversible.** Every task is checkpointed before it touches a file. Undo is undoable. Approvals gate both edits *and* shell commands. Rejecting a change tells the model to change course, not retry.

**It remembers.** Facts, decisions, and gotchas persist per-project in SQLite. Sessions survive crashes (append-only JSONL). New sessions start with a digest of the last one, and the agent searches past conversations when you reference them.

**You can steer it mid-flight.** See it going the wrong way? Just type `use TypeScript, not JavaScript` — and your guidance is injected at the next loop iteration. No cancelling, no wasted tokens.

## Upgrading from Codewright

Faber is Codewright renamed, after the npm name was taken between building and releasing. Existing projects keep working untouched: an existing `.codewright/` state directory is adopted as-is, so memory, code graph, sessions, and usage history all survive. `CW_*` environment variables still work alongside the canonical `FABER_*` names. New projects get `.faber/`.

## Requirements & install

You need Node.js 22.5 or newer. Faber uses Node's built-in SQLite, so there are no native dependencies to compile and installs don't fail on a missing toolchain. The only runtime dependencies are two small pure-JS packages.

```bash
npm install -g faberwright
faber
```

The first time you run it, Faber asks three questions and remembers the answers:

```
Welcome to Faber.
Let's pick where your model comes from. You can change this any time with /route or /model.

Who provides the model?
❯ Anthropic
  OpenAI
  Local
  Other

How should Faber reach it?
❯ Anthropic API                  direct, pay per token with your own key
  Amazon Bedrock                 your AWS account owns auth and billing
  Google Vertex AI               your GCP project owns auth and billing  (not yet wired)

Faber needs an API key for Anthropic API.
  Get one at https://console.anthropic.com/settings/keys
  ANTHROPIC_API_KEY (hidden): ••••••••••••

Default model
❯ sonnet   balanced, a good default for daily work
  opus     most capable, for complex multi-step work
  haiku    fastest and cheapest, for simple tasks
```

Nothing is written until setup finishes. Quit halfway through and the next run starts over from the first question, so you can never end up half-configured. Every later launch checks that your setup can actually reach a model before it opens the prompt, which means a missing key gets caught at startup rather than surfacing as a confusing error partway through a task.

If a key is already in your environment, Faber says so and asks what to do with it: use it and remember it, use it without saving, or replace it with a different one. A key you deliberately paste wins over the environment variable, because an explicit choice shouldn't be silently overridden.

Your key never leaves your machine. Faber has no server and no account of its own, and it talks only to the model provider you pick. Keys you give it are written to `~/.faber/credentials.json` with owner-only permissions, never into your project folder, where a stray `git add` could publish them.

Environment variables still work and still take precedence, so existing setups and CI keep running unchanged:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
faber
```

Setup is skipped entirely when there's no terminal attached, so scripts and CI never block on a prompt. And if you don't have an API key at all, pick **Local → Ollama** during setup and Faber runs against a model on your own machine, no key and no cost.

## Features

| | |
|---|---|
| **Streaming agent loop** | Text renders as generated, with a live heartbeat (`✳ Working… 14s`) that never interleaves with output and ends in `✳ Worked for 14s`. Plan → tool → observe → adjust, until done. Hard iteration cap. |
| **Code graph** | Symbols *and* call/import edges, incrementally maintained (only changed files re-parse). Agent tools: `who_calls` (blast radius), `calls_from` (dependencies), `trace_path` (workflow chain). A compact repo map of the most-connected symbols orients every task. Edges are static hints — dynamic dispatch/DI/events aren't captured; the agent reads code where precision matters. |
| **Approval by default** | Arrow-key menu on every file edit (colored diff) and every shell command. `--auto` / `/auto` / `FABER_APPROVAL=auto` opts into autonomy. |
| **Guided setup** | First run walks through vendor, route, credential and model, then remembers it. Later launches verify the setup can reach a model before opening the prompt. Nothing is saved until setup finishes, so an interrupted run leaves no half-configured state. |
| **Credentials** | Keys live in `~/.faber/credentials.json`, owner-only, outside every repository. Faber checks that what you paste looks like a key before storing it, hides it as you type, and never prints more than a masked fragment. Environment variables keep working and take precedence. |
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
| **Usage dashboard** | `/usage` shows a persistent ledger: tasks, tokens, cache rate, cost, and cache *savings* — for this session, today, and all time, plus totals across every project on the machine. Costs use each model's own rates, including its exact cache read/write prices, so a history spanning a model switch stays accurate. Prices ship built in and update with `/usage --refresh-prices`. Records live in `.faber/usage.db` per project and survive restarts. |
| **Error recovery** | Transient API errors: backoff + jitter, honors Retry-After. Tool errors return to the model to self-correct. Identical call failing twice → warning; three times → clean abort. Ctrl-C aborts streams *and* running commands; checkpoints survive. |
| **Safety rails** | Symlink-resolved path jail, shell denylist, timeouts, output truncation, atomic writes (temp+rename), stale-edit guard. Guardrails, not a sandbox — use a container for untrusted code. |

## Vendors, routes, and models

Faber separates three choices, so you can change one without redoing the others:

| Level | What it decides | How you set it |
|---|---|---|
| **Vendor** | who makes the model | `/route` |
| **Route** | how you reach it and who owns auth | `/route` |
| **Model** | which model on that route | `/model` |

Routes available today: **Anthropic API**, **Amazon Bedrock**, **OpenAI API**, **Ollama** (local, no key and no cost), and any **OpenAI-compatible endpoint** (OpenRouter, Groq, Together, vLLM, a gateway). Google Vertex is defined but not yet wired up — `/route` says so rather than failing at request time.

### Amazon Bedrock

Faber authenticates two ways, and tries them in this order.

**With an IAM role, which needs no key at all.** In SageMaker Studio, on EC2, in ECS or Lambda, or on a laptop where you've run `aws configure`, Faber finds your AWS credentials the same way the SDKs do and signs each request with SigV4. Pick Amazon Bedrock during setup, give it a region, and that's the whole configuration. The signing is implemented directly against Node's crypto module rather than pulling in the AWS SDK, so the zero-dependency install still holds, and it's verified against the signature AWS publishes for its own worked example.

**With a Bedrock API key**, if you'd rather use one:

```bash
export BEDROCK_API_KEY=...
```

Model ids on Bedrock differ by region and deployment, so pin them per alias in your profile instead of relying on the built-in names:

```json
{ "route": "bedrock", "region": "us-west-2",
  "modelPins": { "sonnet": "anthropic.claude-sonnet-4-6-v1" },
  "apiKeyEnv": "BEDROCK_API_KEY" }
```

### Costs

`/usage` shows real dollars without any configuration. Prices come from the best source available, in this order: whatever you set explicitly, then the provider's own published rates (OpenRouter publishes per-token prices including cache reads and writes, and needs no key for it), then a community dataset covering everyone else, then a small table built into Faber so it still works offline. Anthropic and OpenAI don't publish prices through their APIs at all, which is why the last two exist.

```
faber> /usage --refresh-prices     # pull current rates now
```

Keeping those rates current matters more than it might sound, because a task's cost is written down when the task runs and never recalculated. If a vendor raises prices next month, last month's tasks still show what they actually cost. That's the point of a ledger. But it also means a stale price table would bake a wrong number into your history permanently, so Faber fetches prices once during setup and re-checks on every launch using a conditional request. When nothing has changed the server answers with a 304 and no body, which costs about 70ms in the background, so there's no window where an out-of-date rate can slip into your records. The full download only happens when the price list actually changes, and after a failed attempt Faber waits a day before trying again so an offline machine isn't making a doomed request every time you start.

You can turn the automatic refresh off with `FABER_AUTO_PRICES=0` or `"autoRefreshPrices": false` in your profile, in which case Faber falls back to its built-in rates and mentions at startup when they're getting old. This is the only network request Faber makes that isn't an inference call. It fetches a public price list and sends nothing about you.

Costs use each model's own input, output, cache-read and cache-write rates rather than a flat multiplier, and cloud model ids like `us.anthropic.claude-sonnet-5` normalize onto the same entry as the direct one. Setting `FABER_PRICE_IN` and `FABER_PRICE_OUT`, or `priceIn` and `priceOut` in a profile, overrides everything. A model with no known price shows a dash rather than a guess.

Settings live in `~/.faber/settings.json` as named **profiles**:

```json
{
  "activeProfile": "work",
  "profiles": {
    "work":  { "route": "anthropic-api", "model": "sonnet", "apiKeyEnv": "ANTHROPIC_API_KEY_WORK" },
    "local": { "route": "ollama", "model": "qwen2.5-coder" }
  }
}
```

Profiles store the name of the environment variable holding your credential, never the credential itself, so the file is safe to sync between machines or keep in a dotfiles repo. Switch between them with `/profile local`.

Settings resolve in this order, highest first: environment variables, then a project's `.faber/config.json`, then the active profile, then defaults. So a repo can pin its own model while your machine default stays whatever you picked, and an environment variable still overrides both.

## Commands

```
/setup              run setup again (vendor, route, credential, model)
/route              choose a vendor and route
/model [alias]      switch model; lists what your key can actually use
/key [set|rm]       show, save or remove an API key
/profile [name]     list or switch saved profiles
/usage              tokens, cost and cache savings (--refresh-prices)
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
/verbose /concise   full-depth answers, or short ones (default concise)
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
| `FABER_PRICE_IN`, `FABER_PRICE_OUT` | $/Mtok, overrides the built-in price table |
| `FABER_WEAK_MODEL` | cheap model for internal summarization (e.g. a Haiku-class model) |
| `FABER_MAX_ITERATIONS` | loop cap (40) |
| `FABER_CONTEXT_BUDGET` | compaction threshold, tokens (60000) |
| `FABER_SHELL_TIMEOUT` | ms (120000) |
| `FABER_ROUTE`, `FABER_REGION` | route id and region, overriding the profile |
| `FABER_AUTO_PRICES` | `0` disables the background price refresh |
| `BEDROCK_API_KEY` | Bedrock, when you'd rather use a key than an IAM role |
| `AWS_ACCESS_KEY_ID` etc. | picked up automatically for Bedrock's SigV4 signing |

Faber keeps three files. `~/.faber/settings.json` holds your profiles, which is the route, model and which environment variable a credential comes from. `~/.faber/credentials.json` holds the keys themselves, owner-only and outside every repository. A project can override the profile with its own `.faber/config.json`, which is useful when one repo should use a cheaper model than the rest.

Commit protection happens on its own. When Faber starts inside a git repo it writes `.faber/` into `.git/info/exclude`, a local ignore that produces no diff and is never committed, so project state can't reach GitHub even if you forget your `.gitignore`. If `.faber/` was already committed at some point in the past, you get a loud warning with the exact `git rm --cached` command to fix it. This matters because sessions and checkpoints can contain the contents of files the agent read. If teammates will use Faber too, add `.faber/` to the shared `.gitignore` so they're covered from their first run.

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
npm test          # offline test suite, no API key needed
node selftest.mjs # installation self-check + live agent verification (report file to share)
```

The suite deliberately covers the awkward cases rather than the easy ones: undo and redo round-trips, checkpoint ids colliding within the same millisecond, session files torn mid-write, cyclic call graphs, surgical edits through CRLF and emoji, cancellation mid-stream, steering messages keeping the API's role alternation valid, paste markers split across stream chunks, AWS signatures checked against the vector AWS publishes, credential files landing with owner-only permissions, and a recorded cost staying put when prices later change. Several tests drive the real agent loop against a mock streaming server, and one drives the actual CLI binary.

CI runs on Ubuntu, macOS and Windows across Node 22 and 24: tests, build, and CLI smoke on every push.

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

Google Vertex is defined but not yet wired up, since its OAuth flow is a bigger piece than Bedrock turned out to be. Beyond that: tree-sitter for compiler-grade graph edges, evicting stale tool results from long conversations, redacting secrets in session logs, team-shared project settings that can live in a repo, embedding-based recall, a branch-per-task git mode, and a VS Code extension built on this core.

## License

Apache-2.0 — see LICENSE.
