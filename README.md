<p align="center">
  <a href="https://ibb.co/HDYGBwHt">
    <img src="https://i.ibb.co/DDkwzcR9/Chat-GPT-Image-6-ago-2026-11-47-58-p-m-1.png" alt="tradwife" width="320" />
  </a>
</p>

<h1 align="center">tradwife</h1>

<p align="center">
  <strong>remembers everything</strong>
</p>

<p align="center">
  Local, persistent and auditable memory for AI coding agents.<br/>
  Syncs across every machine you own, through your own private GitHub repo.
</p>

<p align="center">
  <a href="https://github.com/ma-nucho-pro/tradwife/actions/workflows/ci.yml"><img src="https://github.com/ma-nucho-pro/tradwife/actions/workflows/ci.yml/badge.svg" alt="tests" /></a>
  <img src="https://img.shields.io/badge/license-MIT-8fbf6a?style=for-the-badge" alt="license MIT" />
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?style=for-the-badge" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/local--first-no%20cloud-ff6b8a?style=for-the-badge" alt="local first" />
  <img src="https://img.shields.io/badge/node-%E2%89%A518.17-6f42c1?style=for-the-badge" alt="node 18.17+" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude%20Code-full-f5a623?style=for-the-badge" alt="Claude Code" />
  <img src="https://img.shields.io/badge/Codex-full-444444?style=for-the-badge" alt="Codex" />
  <img src="https://img.shields.io/badge/Cursor-full-0098FF?style=for-the-badge" alt="Cursor" />
  <img src="https://img.shields.io/badge/Gemini%20CLI-injection%20only-8E75B2?style=for-the-badge" alt="Gemini CLI" />
</p>

<p align="center">
  <a href="#why">Why</a> •
  <a href="#what-it-actually-does">What it does</a> •
  <a href="#install">Install</a> •
  <a href="#which-agents-and-how-far">Agents</a> •
  <a href="#commands">Commands</a> •
  <a href="#security">Security</a> •
  <a href="#faq">FAQ</a>
</p>

> **Your AI coding agent forgets you every morning.** You re-explain your stack,
> your language, your conventions — every single session. tradwife gives Claude
> Code, Codex, Cursor and Gemini CLI a memory that survives the session boundary,
> stays under a hard token ceiling, and follows you to every machine you work on.
> No cloud, no account, no API key, zero dependencies.

---

```
$ tradwife show

Identity (5 facts)
  Who
  - Full-stack developer, mostly backend
  - Ships side projects solo, nights and weekends
  Preferences
  - Prefers short, implementation-first answers
  - Dislikes long explanations of things already known
  Working style
  - Always answer in Spanish
  █░░░░░░░░░░░░░░░░░░░░░░░ 61/1200 tokens

Project · checkout-api (3 facts)
  Stack
  - Uses Postgres, Fastify and Vitest
  Conventions
  - Never commit directly to main
  - Run the migrations before the test suite
  ░░░░░░░░░░░░░░░░░░░░░░░░ 27/800 tokens

Injected at session start
  ██░░░░░░░░░░░░░░░░░░░░░░ 174/2000 tokens
```

That block is handed to Claude Code and Codex at the start of **every** session. You never typed it. Tradwife learned it from things you already said, and it forgets anything you delete.

---

## Why

You explain your stack. You explain that you want short answers. You explain that this repo runs migrations before tests. The session ends.

Tomorrow, you explain all of it again.

That is not a context-window problem — a model handles one session fine. The problem is that **nothing survives the session boundary**, and nothing ever learns. Instruction files are documents you maintain by hand. Session resume only reaches backwards into a single conversation. Compaction throws away the parts of a session it judges irrelevant to the current task, which is exactly where facts about *you* live.

Tradwife closes that gap with the only thing that actually works: **a curator.**

---

## What it actually does

Storing text is trivial. The hard part — the entire product — is deciding **what deserves to be remembered, what replaces what, and what has to go.**

### It waits before it believes you

A fact you mention once is **staged**, not stored. It has to come back in a *different* session before it reaches long-term memory. State it deliberately — `remember that…`, `always…`, `never…`, or `tradwife remember` — and it lands immediately, because you meant it.

This single rule is why Tradwife's memory stays small enough to trust.

### It has a hard ceiling

1200 tokens for who you are. 800 for the current project. When a section fills up, the lowest-scoring fact is **evicted**, not appended.

```
score = confidence × recency × repetition × intent
```

Recency decays on a 90-day half-life for identity, 45 days for project memory. Pinned facts never decay and are never evicted. The ceiling is the design: without it, memory grows until it costs you tokens on every single turn.

### It resolves contradictions instead of stacking them

Move off a framework and the old fact is **replaced**, with the change recorded. Restate something more precisely and the vaguer version is absorbed.

Two statements only merge when one strictly contains the other:

| Statement A | Statement B | Result |
|---|---|---|
| `Prefers short answers` | `Prefers short direct answers` | merged — B is more specific |
| `Deploys to production on Friday` | `Deploys to staging on Friday` | **kept apart** — each says something the other does not |
| `Uses Postgres` | `Uses MySQL` | kept apart |
| `Uses Redis` | `Never uses Redis` | superseded — you changed your mind |

### It lets go of what you stopped believing

Contradict a fact and it is replaced on the spot. But most beliefs don't die
that cleanly — you just quietly stop working that way, and never say so.

Go quiet about something for long enough and it goes **dormant**: out of the
injected context, still visible in the file under `## Dormant`. Say it again and
it comes straight back. Delete the line and it's gone for good.

```
## Dormant
_Not mentioned in a long time, so these are no longer sent to the agent._
_Say one again and it comes back. Delete the line to forget it for good._
- Uses Redis for caching
```

120 days for identity, 60 for the project, doubled for anything you stated
deliberately. Pinned facts never go dormant — that's what pinning is for.

### It notices what follows you between repos

Say "never commit directly to main" in one codebase and it's a house rule. Say
it in your last three codebases and it's how you work. At three repos, a project
fact is promoted into identity automatically, where it follows you everywhere.

`tradwife spread` shows what's on its way there.

### It follows you between machines, by itself

Most people running a coding agent already have git working and the GitHub CLI
signed in. If that is you, this is the whole setup:

```bash
tradwife sync setup     # creates a PRIVATE repo on your account and pushes
```

No URL to paste, no repo to create, no token to generate. On your second and
third machine:

```bash
tradwife clone          # finds the repo on your account by itself
```

From then on it is automatic: every session start pulls what the other machines
learned, every session end pushes what this one did. Nothing to remember.

**Not set up with GitHub?** Nothing breaks. `tradwife sync setup` tells you
exactly what is missing and gives you the command for macOS, Ubuntu or Windows —
and if you would rather not install anything, create a private repo yourself and
pass it: `tradwife sync setup <url>`. Every path is tested.

**Why a git repo and not an MCP server.** MCP exposes tools to an agent during a
conversation. Syncing memory is not something the agent does — it happens before
and after the session, and it is a filesystem and network problem. Git already
merges, versions and works offline; an MCP server would add a process that has
to be running for something `git push` does, and put a failure point between you
and your own memory.

Two things never leave your machine: `sessions/` is git-ignored, so raw prompts
are never pushed, and the credential screen runs before anything is written, so
a pasted API key is not in the repo either. Both are asserted in the test suite.

#### What happens when two machines both learned something

Facts are content-addressed and carry their own provenance, so they merge by
**meaning** rather than by line — which is the thing pushing a folder to a repo
cannot do for you.

| Situation | What happens |
|---|---|
| Same fact on both machines | sessions are unioned, latest sighting wins |
| Only on one, and it was in the ancestor | the other machine deleted it — **deletion wins** |
| Only on one, and it is new | kept |
| Contradiction across machines | the newer statement wins, the old one is dropped |
| Candidate waiting on both | sessions merge — **the two-session gate spans machines** |

That last row is the quiet win: say something once on the laptop and once on the
desktop, and it is finally enough to be remembered.

Nothing here is limited to two machines. Seven laptops converge as cleanly as two.

### It only reads what you wrote

Your agent's replies are **never** mined. When a model suggests "let's use Postgres" and you answer "ok", it has not learned a fact about you — it has heard its own idea repeated back. Tradwife reads your prompts and nothing else.

### It separates you from your repo

Facts about **you** follow you everywhere. Facts about **this codebase** stay in this codebase.

```
"always answer in Spanish"           →  identity      (follows you to every repo)
"never commit directly to main"      →  checkout-api  (stays here)
"I never deploy on Fridays"          →  identity      (your habit, not the repo's)
"this project uses Fastify"          →  checkout-api
```

### Every single fact is traceable

```
$ tradwife why "short answers"

Prefers short, implementation-first answers
  store       identity · section "Preferences"
  source      it came up in enough separate sessions to be promoted
  confidence  0.75
  seen        3 times across 3 sessions
  first       2026-07-14 09:22:41
  last        2026-07-29 18:03:12
  score       0.847 (confidence x recency x repetition x intent)
  you wrote   "prefiero respuestas cortas, sin tanta explicación"
```

If you cannot see where a memory came from, you cannot trust it. Tradwife shows you.

### It is a markdown file you own

`~/.tradwife/identity.md` is the source of truth. Open it in any editor. **Delete a line and it is forgotten** — no command needed. **Add a line by hand and it is kept at full confidence.** `git init` it if you want history.

No database. No daemon. No account. No network call. Ever.

---

## Install

### Option 1 — let your agent do it

Copy this and paste it into **Claude Code** or **Codex**:

```
Install "Tradwife", a local memory layer for coding agents, from
https://github.com/ma-nucho-pro/tradwife

Do exactly this:
1. git clone https://github.com/ma-nucho-pro/tradwife.git ~/.local/share/tradwife
2. cd ~/.local/share/tradwife
3. npm link          (this puts the `tradwife` command on my PATH)
4. tradwife init
5. tradwife attach claude          (use `tradwife attach codex` if you are Codex)
6. tradwife status                 and show me the output

Do not modify any of my existing hooks or settings beyond what
`tradwife attach` does. It merges into my settings file without
removing anything. If `npm link` fails with a permission error,
tell me instead of using sudo.
```

Then **restart your agent**. That is it.

> This repo ships a `CLAUDE.md` and an `AGENTS.md`, so if your agent is already sitting inside the cloned folder it knows how to install itself without any prompt at all.

### Option 2 — one command

```bash
curl -fsSL https://raw.githubusercontent.com/ma-nucho-pro/tradwife/main/install.sh | bash
```

### Option 3 — by hand

```bash
git clone https://github.com/ma-nucho-pro/tradwife.git
cd tradwife
npm link          # puts the `tradwife` command on your PATH
tradwife init         # creates ~/.tradwife and attaches whatever it finds
tradwife attach claude
```

On **Windows**, use Option 3 in PowerShell — the install script needs bash.

Requires **Node 18.17 or newer**, which you already have if you are running Claude Code. There is no build step and **zero runtime dependencies**: the whole tool is plain Node with nothing pulled from npm.

### Already have a CLAUDE.md? Start from it.

```bash
tradwife import          # --dry-run to see it first
```

Reads `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and this repo's `CLAUDE.md`
or `AGENTS.md`, and seeds memory from them. The scope of the file decides the
scope of the fact: your user file becomes identity, the repo's file becomes
project memory.

Credentials are screened out before anything is written, code blocks and
install steps are ignored, and Tradwife never re-reads its own managed block.

### Check it worked

```bash
tradwife status
```

Then open a new session. In Claude Code, `/hooks` will list three entries. Nothing else about how you work changes.

### Uninstall

```bash
tradwife detach claude
tradwife detach codex
rm -rf ~/.tradwife        # only if you also want the memory gone
```

`detach` removes Tradwife's hooks and leaves every other hook in your settings exactly as it was.

---

## Which agents, and how far

Not every agent exposes the same lifecycle, so this is exactly what each one does.

| | Injects memory | Learns from your sessions | Enforces guards |
|---|---|---|---|
| **Claude Code** | `SessionStart` | `UserPromptSubmit` + `SessionEnd` | `PreToolUse` |
| **Codex** | `SessionStart` | `UserPromptSubmit` + `Stop` | `PreToolUse` |
| **Cursor** | rules file, rewritten at `stop` | `beforeSubmitPrompt` + `stop` | `beforeShellExecution` |
| **Gemini CLI** | `GEMINI.md` | **no** | **no** |

```bash
tradwife attach claude
tradwife attach codex
tradwife attach cursor
tradwife attach gemini
```

All four read the same memory, so a fact learned in Claude Code shows up in Codex.

**Codex** needs hooks, which went stable in v0.124.0. `tradwife attach codex` also
enables `[features] codex_hooks` for older builds and writes an `AGENTS.md`
block as a fallback for versions predating the hook engine entirely.

**Cursor** has no session-start event whose output becomes context, so memory is
injected through an always-applied rule at `.cursor/rules/tradwife-memory.mdc`,
rewritten by the `stop` hook at the end of every session. The loop still closes;
it is just one session behind on facts learned minutes ago.

**Gemini CLI** gets injection only. Its hook engine exists, but wiring to an
event name this integration cannot verify would fail silently — the worst
outcome for a memory tool — so `GEMINI.md` it is. Refresh with `tradwife sync-gemini`,
or let a Claude Code or Codex session on the same machine keep the store current.

Blocking works differently in each: Claude Code takes a `permissionDecision`,
Codex wants exit code 2, Cursor wants `{ permission: "deny" }`. Cursor also
names things differently — `conversation_id` and `text` where the others send
`session_id` and `prompt`. All of that is handled, and tested against each
agent's documented payload.

## How it works

Three hooks. No wrapper around your agent, so your workflow is untouched.

```
SessionStart      →  tradwife inject     puts your memory into the session
UserPromptSubmit  →  tradwife capture    buffers what you typed, silently
SessionEnd        →  tradwife harvest    curates the session into memory
```

The curator runs in four steps:

```
      what you typed
            │
   1. extract      pattern rules, Spanish and English,
            │      tuned to miss rather than to invent
            ▼
   2. gate         explicit? store now.
            │      otherwise stage it and wait for a second session
            ▼
   3. reconcile    reinforce · supersede on contradiction · add
            │
            ▼
   4. prune        enforce the token ceiling, lowest score first
            │
            ▼
     identity.md + projects/<repo>/project.md
```

**Extraction is deterministic pattern matching, not an LLM call.** No API key, no cost per session, no network, and behaviour you can read in one file and predict. It fires on the phrasings people actually use when stating something durable — `recuerda que`, `siempre`, `nunca`, `prefiero`, `no uses`, `usamos`, `me llamo`, and their English equivalents — and throws out anything that is a question, a task, code, a path, a URL, a pasted log, or a credential.

**Facts are written in the language you said them in.** Spanish in, Spanish out.

**Crash safety.** If your agent is killed, your laptop dies, or `SessionEnd` never fires, the buffer is picked up at the next `SessionStart`. Session buffers are the only place raw prompt text is written, and they are deleted the moment they are harvested.

**The injected block reads as plain factual statements**, never as commands, so it is used as context instead of being flagged and surfaced back to you.

---

## Commands

### Memory

| Command | What it does |
|---|---|
| `tradwife import` | seed from your existing CLAUDE.md / AGENTS.md — `--dry-run` |
| `tradwife review` | decide what stays: waiting candidates and dormant facts |
| `tradwife spread` | facts showing up in more than one repo |
| `tradwife harden` | turn rules a hook can enforce into real guards |
| `tradwife guards` | what is enforced — `--add … --blocks …`, `--test …`, `--off …` |
| `tradwife remember "<fact>"` | store it now — `--project`, `--section X` |
| `tradwife forget "<text>"` | remove it entirely |
| `tradwife pin "<text>"` | exempt from decay and eviction |
| `tradwife unpin "<text>"` | undo that |
| `tradwife why "<text>"` | where it came from and what it replaced |
| `tradwife edit` | open the memory file in `$EDITOR` — `--project` |

### Inspect

| Command | What it does |
|---|---|
| `tradwife show` | exactly what your agent will be given — `--raw`, `--verbose` |
| `tradwife status` | memory size, wiring, pending buffers |
| `tradwife journal` | audit trail of every change — `-n 50`, `--event added` |
| `tradwife doctor` | duplicates, drift, broken wiring — `--fix` |
| `tradwife config [key] [value]` | read or change settings |

### Setup

| Command | What it does |
|---|---|
| `tradwife init` | create `~/.tradwife` and attach whatever is installed |
| `tradwife attach <agent>` | `claude` · `codex` · `cursor` · `gemini` — `--project` |
| `tradwife detach <agent>` | remove it cleanly |
| `tradwife sync-gemini` | refresh the Gemini block |
| `tradwife sync setup` | create a private GitHub repo and push — no URL needed |
| `tradwife sync` | commit, merge the other machines in, push |
| `tradwife sync status` | how far this machine has drifted |
| `tradwife clone` | set up a new machine — finds your repo by itself |
| `tradwife sync-codex` | refresh Tradwife's block in `AGENTS.md` |

### Lifecycle

`tradwife inject`, `tradwife capture` and `tradwife harvest` are what the hooks call. You rarely run them by hand, though `tradwife harvest --verbose` is the best way to see what the curator accepted and why it rejected the rest.

---

## Security

Tradwife reads every prompt you type. That is only acceptable under strict rules, so here they are.

**Credentials never reach disk.** Anything matching a credential shape disqualifies the entire candidate — it is dropped, not masked, because a masked fact still leaks its context.

| Screened | Examples |
|---|---|
| Provider keys | `sk-…`, `sk-ant-…`, `ghp_…`, `AKIA…`, `AIza…`, `xox…`, `sk_live_…` |
| Tokens | JWTs, `Bearer …`, `Authorization:` headers |
| Secrets in assignments | `password=`, `api_key=`, `secret=`, `token=` |
| Connection strings | `postgres://user:pass@…`, `mongodb+srv://…`, `redis://…` |
| Key material | `-----BEGIN … PRIVATE KEY-----` |
| Entropy | long hex digests and high-entropy base64 blobs |

Add your own with `tradwife config denyPatterns '["client-name","internal-codename"]'`.

**Nothing leaves your machine.** No telemetry, no analytics, no network calls, no accounts. `~/.tradwife` is a folder of markdown and JSON on your disk.

**Raw prompts are transient.** They live in a session buffer only until that session is curated, then the buffer is deleted.

**Everything is reversible.** `tradwife forget` removes a fact completely. Deleting a line from `identity.md` does the same. The journal records that a removal happened and when, never resurrecting the content.

**Pause it whenever you want:** `tradwife config capture false` stops learning while still injecting what it already knows.

---

## Architecture

```text
~/.tradwife/
  identity.md            you. hand-editable, the source of truth
  identity.index.json    confidence, seen counts, provenance
  projects/
    checkout-api-a1b2c3d4/
      project.md         this repo. same rules
      project.index.json
      meta.json
  sessions/              prompt buffers, deleted once curated
  cross-project.json     which facts have shown up in more than one repo
  journal.jsonl          append-only audit log
  config.json
```

The `.md` files are what you read and edit. The `.json` sidecars hold metadata that has no readable place in a bullet list.

**Markdown always wins.** On every load Tradwife reconciles the index against the file, so a line you delete by hand is forgotten and a line you add is adopted at full confidence. You are never fighting the tool for control of your own memory.

---

## Configuration

```bash
tradwife config                              # show everything
tradwife config budget.identity 2000         # more room for who you are
tradwife config promotionThreshold 3         # be even more sceptical
tradwife config halfLife.project 30          # project facts go stale faster
tradwife config denyPatterns '["acme-corp"]' # never store anything matching this
tradwife config capture false                # pause learning, keep injecting
tradwife config autoSync false               # sync only when you ask
tradwife config autoSyncMinutes 15           # sync at most every 15 minutes
tradwife config dormancy.identity 180        # be slower to let go of who you are
tradwife config crossProjectThreshold 2      # promote to identity sooner
```

---

## FAQ

**Does this send anything anywhere?**
No. There is no network code in this repo outside of `git clone` during install. Memory is markdown on your disk.

**Does it cost tokens?**
About 150–250 tokens per session, once, at the start. That is roughly what you spend re-explaining your stack in a single message.

**Does it need an API key?**
No. Extraction is pattern matching, not a model call.

**What if it remembers something wrong?**
`tradwife forget "<text>"`, or open `~/.tradwife/identity.md` and delete the line. Both are permanent.

**What if it misses something important?**
`tradwife remember "<fact>"` stores it immediately at full confidence. Saying `remember that…` or `always…` in a normal prompt does the same thing.

**Isn't a rule in a prompt just a suggestion?**
For some rules, yes, and that is a fair criticism. `tradwife harden` finds the ones a
hook can enforce and turns them into `PreToolUse` guards you approve one by one.
The rest — tone, language, preferences — correspond to no tool call, so a hook
cannot express them either way.

**What happens to something that stops being true?**
Three ways out. Contradict it and the old fact is replaced immediately, with the
change recorded. Say nothing for long enough and it goes dormant — out of the
context, still in the file, revived the moment you mention it again. Or delete
the line yourself. Nothing silently rots.

**Can I use it on several machines?**
That is what it is for. `tradwife sync setup` on the first one creates a private
repo on your GitHub account; `tradwife clone` on the rest finds it by itself.
After that it syncs on its own at the start and end of every session. Memory
merges by meaning rather than by line, so two machines that both learned things
in the same week end up with everything rather than one of them winning. No
two-machine limit.

**Do I need the GitHub CLI?**
It makes it one command instead of three. Without it, create a private repo
yourself and run `tradwife sync setup <url>` — same result, tested.

**Is my memory public?**
No. The repo is created private, and that is not configurable, because this
holds a profile built from everything you type into your agent. Raw prompts are
never pushed at all.

**Does it work with both Claude Code and Codex at the same time?**
Yes. Both read the same memory, so a fact learned in one shows up in the other.

**Can I edit the memory by hand?**
That is the intended way to use it. The markdown file is the source of truth and your edits always win.

**Which languages does it understand?**
Spanish and English out of the box, and it writes each fact back in the language you said it in. Adding a language is a rule block in `src/core/extract.js` — pull requests welcome.

---

## Verify it yourself

```bash
npm run check
```

**179 unit tests**, a **77-check end-to-end run**, a **63-check multi-agent run**, a **34-check GitHub run**, and a **38-check multi-machine
convergence run** using real git that spawns the real CLI and feeds it the exact JSON Claude Code puts on a hook's stdin. Among the things it proves:

- a credential pasted into a prompt never appears anywhere under `~/.tradwife`
- a task ("fix the login bug") never becomes a memory
- a preference stated once is *not* stored; stated again in a different session, it is
- attaching over an existing settings file preserves every other hook and setting
- attaching three times produces three handlers, not nine
- every hook command exits 0 given no stdin, garbage stdin, a null prompt, a 500 KB prompt, or a session id of `../../../etc/passwd`
- a corrupt index file is quarantined and recovered from instead of crashing
- a buffer from a session that never ended is picked up at the next start
- the CLI works through the symlink `npm link` installs, not just as a direct file
- a credential inside an imported CLAUDE.md is dropped, underscores and all
- a fact gone quiet for months stops being injected but stays in the file
- saying a dormant fact again revives it, back to its original section
- one repo repeating itself never triggers cross-project promotion; three do
- three machines diverging in parallel converge to an identical set of facts
- a fact deleted on one machine stays deleted on the others after a sync
- a candidate seen once on each of two machines is promoted, exactly as it would
  be within one
- a description ("Uses pnpm", "Deploys on Thursdays") never becomes a blocking guard
- a commit guard blocks on main and allows the identical command on a feature branch
- a malformed guard pattern allows the call instead of throwing
- `PreToolUse` is not registered at all until a guard exists
- Codex wires `Stop`, not `SessionEnd` — Codex has no such event, and a hook on
  a name that does not exist never fires and never says so
- Cursor's `conversation_id` / `text` payload is understood, and Cursor gets an
  explicit `allow` rather than silence
- a Codex guard denies with exit code 2, not with a JSON decision object
- attaching to Codex three times leaves one `codex_hooks = true`, and the rest of
  your `config.toml` untouched, blank lines included
- `sync setup` with no arguments creates a **private** repo and pushes it
- a machine with no GitHub CLI gets install commands and a working manual route
- a dead remote never stops a session from starting, and never breaks harvest
- no credential and no session buffer appears anywhere in git history

CI runs the whole suite on Linux, macOS and Windows across Node 18, 20 and 22.

---

## Contributing

Tradwife is **open source under the MIT license**. Fork it, modify it, ship it inside your own tools, use it commercially. The only condition is the one MIT already sets: **keep the copyright notice and attribution to Roberto Manuel Jara Peche.**

Good places to start:

- **Add a language.** A rule block and a label set in `src/core/extract.js`, plus tests.
- **Sharpen the extractor.** If a phrasing you use constantly is being missed, add a rule for it.
- **Improve scoping.** The heuristic that decides "about me" versus "about this repo" can always get better.
- **Add an agent.** The integration surface is one file per agent in `src/agents/`.

Every pull request must keep `npm run check` green. New behaviour needs a test — that rule is why this repo is trustworthy.

Found a bug or have an idea? [Open an issue](https://github.com/ma-nucho-pro/tradwife/issues).

---

## Author

**Roberto Manuel Jara Peche**

<p>
  <a href="https://github.com/ma-nucho-pro"><img src="https://img.shields.io/badge/GitHub-ma--nucho--pro-181717?style=for-the-badge&logo=github" alt="GitHub" /></a>
  <a href="https://www.youtube.com/@ManuchoAI"><img src="https://img.shields.io/badge/YouTube-@ManuchoAI-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube" /></a>
  <a href="https://x.com/ManuchoAI"><img src="https://img.shields.io/badge/X-@ManuchoAI-000000?style=for-the-badge&logo=x&logoColor=white" alt="X" /></a>
  <a href="https://www.instagram.com/robertmanuchojp/"><img src="https://img.shields.io/badge/Instagram-robertmanuchojp-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram" /></a>
  <a href="https://www.linkedin.com/in/roberto-manuel-jara-peche-10867240b/"><img src="https://img.shields.io/badge/LinkedIn-Roberto%20Manuel%20Jara%20Peche-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
</p>

If Tradwife saves you from re-explaining yourself, a ⭐ on the repo helps other people find it.

---

## License

MIT © 2026 Roberto Manuel Jara Peche — see [LICENSE](LICENSE).
