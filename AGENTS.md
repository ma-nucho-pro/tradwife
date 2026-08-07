# Instructions for the AI agent reading this

You are being asked to install **tradwife**, a local memory layer for coding
agents. Follow these steps exactly and report the output of the last one.

## Install

```bash
git clone https://github.com/ma-nucho-pro/tradwife.git ~/.local/share/tradwife
cd ~/.local/share/tradwife
npm link
tradwife init
```

If `npm link` fails with a permission error, report it to the user rather than
retrying with sudo — the usual cause is that npm's global bin directory is not
on PATH, and sudo hides that rather than fixing it.

## Wire it into this agent

Run whichever line matches the tool you are:

```bash
tradwife attach claude    # Claude Code
tradwife attach codex     # Codex / ChatGPT CLI
tradwife attach cursor    # Cursor
tradwife attach gemini    # Gemini CLI (injection only — it will not learn)
```

`attach` merges into the user's existing hook configuration and removes nothing.

## Bring across what they already have

```bash
tradwife import --dry-run   # show what it would take from their CLAUDE.md / AGENTS.md
tradwife import             # apply it
```

Show the user the dry run before applying it.

## Offer sync across their machines

```bash
tradwife sync setup
```

With no URL this creates a **private** repo on their GitHub account and pushes.
It needs the GitHub CLI signed in. If it reports that something is missing, read
the instructions it prints to the user rather than improvising — every failure
path prints the exact command for their operating system.

On their other machines, the command is `tradwife clone` with no arguments.

## Confirm

```bash
tradwife status
```

Show the user this output, then tell them to **restart the agent** so the hooks
load.

## If the user asks what it does

Read `COMO-FUNCIONA.md` in this repo (Spanish) or the README (English). Do not
guess: the design has specific rules — a two-session promotion gate, a hard token
ceiling, dormancy — and describing it as "it saves your chats" is wrong and will
mislead them.

## Rules that are not negotiable if you modify it

- `npm run check` must stay green. It is 179 unit tests plus four end-to-end
  suites. New behaviour needs a new test.
- Never mine the agent's own output. tradwife reads user prompts only.
- Never let a credential reach disk. `src/core/redact.js` screens every
  candidate before anything is written.
- Never remove the token ceiling. It is why the memory stays trustworthy.
- Hook-facing code must never exit non-zero, and guards must fail open.


---

# Tradwife — notes for the agent reading this (Codex reads this file)

Tradwife is a local memory layer for coding agents. It has zero runtime
dependencies and no build step: the source in `src/` is what runs.

## If the user wants to install it

Run these, in this order, from this folder:

```bash
npm link            # puts the `tradwife` command on their PATH
tradwife init           # creates ~/.tradwife
tradwife attach claude  # or: tradwife attach codex
tradwife status         # confirm, then show them the output
```

Then tell them to **restart their agent** so the hooks load.

`tradwife attach` merges into the existing settings file and removes nothing.
If `npm link` fails with a permission error, report it rather than reaching
for sudo — the usual cause is that npm's global bin directory is not on PATH.

## If the user wants to change something

Run `npm run check` before and after. It is 90 unit tests plus a 77-check
end-to-end run and it must stay green. New behaviour needs a new test.

Where things live:

- `src/core/extract.js` — the pattern rules that turn prompts into candidate
  facts, plus the rejection filters. Most feature requests land here.
- `src/core/store.js` — markdown file plus metadata sidecar, scoring, pruning.
  Hand edits to the markdown always win over the sidecar.
- `src/core/harvest.js` — the curator: extract, gate, reconcile, retire, prune.
- `src/core/import.js` — seeding from existing CLAUDE.md / AGENTS.md. Screens for
  credentials BEFORE any text cleanup; reversing that order once let a token
  through, because stripping markdown emphasis also ate the underscore.
- `src/core/crossproject.js` — the only state that spans repos.
- `src/core/guards.js` — rules that a PreToolUse hook can enforce. Guards must
  FAIL OPEN and must never be created without the user approving each one. A
  description ("Uses pnpm") is not a prohibition and must never become a guard.
- `src/core/merge.js` + `src/commands/gitsync.js` — multi-machine sync. Two traps
  live here: `merge=ours` is NOT a git built-in and must be defined as a driver
  or every sync dies on a markdown conflict; and markdown must be DELETED before
  regenerating from a merged index, or Store.load re-adopts facts the other
  machine deliberately deleted.
- `src/agents/` — one file per agent integration.
- `src/commands/hooks.js` — code that runs inside a hook. It must never exit
  non-zero and must never print anything unexpected to stdout.

## Rules that are not negotiable

- Never mine the agent's own output. Tradwife reads user prompts only.
- Never let a credential reach disk. `src/core/redact.js` screens every
  candidate; a match drops the whole candidate rather than masking it.
- Never remove the token ceiling. It is the reason the memory stays trustworthy.
- Never let import read Tradwife's own managed block. That is a feedback loop.
