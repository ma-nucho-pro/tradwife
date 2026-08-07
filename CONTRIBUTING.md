# Contributing to Tradwife

Thanks for being here. Tradwife is MIT licensed and contributions are welcome.

## Setup

```bash
git clone https://github.com/ma-nucho-pro/tradwife.git
cd tradwife
npm run check     # 90 unit tests + 77 end-to-end checks, no install needed
```

There are no dependencies to install and nothing to build.

## The one rule

`npm run check` must stay green, and new behaviour needs a new test.

That rule is the reason this repo can be trusted with your prompts. Several
real bugs in the original build — a merge that collapsed two different facts,
a validator that ran after truncation, a CLI that silently did nothing once
installed through a symlink — were caught by tests and nothing else.

## Good first contributions

**Add a language.** `src/core/extract.js` holds a `RULES` table and a `LABEL`
map. A new language is a block of patterns plus its labels, plus tests in
`test/extract.test.js`. Facts are written back in the language they were said
in, so both halves are needed.

**Sharpen the extractor.** If a phrasing you use constantly is being missed,
add a rule. Precision beats recall here: a memory the user has to correct is
worse than one that occasionally misses. Every new rule needs a test proving
it fires, and ideally one proving it does *not* fire on a near miss.

**Improve scoping.** `classifyScope` decides whether a fact is about the person
or about the repository. It weighs three vocabularies against each other and
can always get better.

**Add an agent.** One file in `src/agents/`, exposing attach / detach / status,
plus tests proving the attach is non-destructive and idempotent.

## Style

- ES modules, Node built-ins only. No dependency is worth taking for this tool.
- Comments explain *why*, not *what*. If a line looks strange, say why it is
  that way — usually because something obvious was tried first and broke.
- Hook-facing code (`src/commands/hooks.js`) never exits non-zero. A crashing
  hook shows an error on every prompt and teaches people to uninstall.

## Pull requests

Describe what changed and why, and mention the test that covers it. Small and
focused beats large and sweeping.
