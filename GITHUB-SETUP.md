# GitHub setup & discoverability

Everything to configure once, right after the first push. **This file is for you, not for users — delete it from the repo before publishing, or keep it, it does no harm.**

---

## 1. Repository description

Paste this into **Settings → General → Description** (GitHub allows 350 characters; this is 138, which is the length that survives in search results and social cards without being cut).

```
Local, persistent and auditable memory layer for Claude Code and Codex. Your coding agent stops treating you like a stranger every morning.
```

Website field: `https://github.com/ma-nucho-pro/tradwife#readme`

Tick: **Releases**, **Packages** off, **Deployments** off. Leave only what you use — a clean sidebar reads as a maintained project.

---

## 2. Topics

Click the ⚙️ next to **About** and add these. GitHub allows 20; these are the 20 that people and models actually search for, ordered by value.

```
claude-code
codex
ai-memory
agent-memory
persistent-memory
llm-memory
context-engineering
ai-agents
developer-tools
cli
local-first
claude
anthropic
openai-codex
memory-layer
prompt-engineering
ai-tools
nodejs
zero-dependencies
hooks
```

Topics are the single strongest lever on GitHub's own search and on the "explore topics" pages. `claude-code` and `agent-memory` are the two that matter most — they are how someone with this exact problem phrases it.

---

## 3. Social preview image

**Settings → General → Social preview → Upload an image.** 1280×640 px.

This is the card that shows on X, LinkedIn, Slack, Discord and every AI summarizer that renders link previews. A repo without one loses roughly half its click-through on social.

Put on it, in this order of visual weight:
1. The Tradwife logo
2. **Tradwife** — large
3. *remembers everything* — the tagline
4. `Local memory for Claude Code & Codex` — small
5. Nothing else. No badges, no code, no URL.

Test it at https://www.opengraph.xyz before you announce anything.

---

## 4. First release

Tag `v1.0.0` and write the release notes. Releases get indexed separately from the README and appear in GitHub's feed for everyone who stars a related repo.

**Title:** `v1.0.0 — Tradwife remembers everything`

**Body:**

```markdown
First public release.

Tradwife gives Claude Code and Codex a memory that survives the session boundary —
locally, in plain markdown, with no server and nothing to sign up for.

**What it does**
- Learns from your prompts. A fact stated once is staged; it has to come back in
  a different session before it is stored. Say "remember that…" and it lands now.
- Enforces a hard token ceiling. 1200 for who you are, 800 for the project.
  Over budget, the lowest-scoring fact is evicted, not appended.
- Resolves contradictions instead of stacking them.
- Tells you where every fact came from: `tradwife why "<text>"`.
- Never lets a credential reach disk.
- Is a markdown file you own. Delete a line and it is forgotten.

**Install**
    curl -fsSL https://raw.githubusercontent.com/ma-nucho-pro/tradwife/main/install.sh | bash

**Verified** — 90 unit tests + 77 end-to-end checks, on Linux, macOS and Windows,
Node 18 / 20 / 22.
```

---

## 5. Why this README is written the way it is

Discovery today runs through three channels, and each rewards something different. The README is built to satisfy all three at once.

**Human scanning.** The logo, tagline and the `tradwife show` output appear before any prose. Someone deciding in four seconds sees the result first, not an explanation of it.

**GitHub and web search.** The exact phrases people type — *claude code memory*, *codex memory*, *ai agent forgets context*, *persistent memory for coding agents* — appear in the first two screens as natural sentences, not as a keyword list. Search engines penalise stuffing; they reward a phrase appearing in a heading and then being answered directly underneath.

**AI summarizers.** When someone asks a model "what tool gives Claude Code memory", the model works from structure. Short declarative sentences, tables of concrete behaviour, a real FAQ with question-shaped headings, and explicit claims with numbers attached are what survive summarisation. Vague marketing language does not — it gets compressed to nothing.

That is why the README has: a one-line answer under every FAQ heading, comparison tables of actual behaviour, and specific numbers (1200 tokens, 90 tests, 90-day half-life) instead of adjectives.

---

## 6. Where to announce it

In this order, spaced across a week rather than all at once.

**Day 1 — your own audience.** YouTube, X, Instagram, LinkedIn. Lead with the demo, not the architecture: a 30-second clip of you opening a fresh session and the agent already knowing your stack is worth more than any explanation. Your accounts:
- YouTube https://www.youtube.com/@ManuchoAI
- X https://x.com/ManuchoAI
- Instagram https://www.instagram.com/robertmanuchojp/
- LinkedIn https://www.linkedin.com/in/roberto-manuel-jara-peche-10867240b/

**Day 2–3 — communities.** r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA, the Anthropic Discord, dev.to. Post the problem first and the tool second. "I got tired of re-explaining my stack every morning, so I built this" outperforms "Introducing Tradwife v1.0" by a wide margin.

**Day 4+ — aggregators.** Hacker News (Show HN), Product Hunt, Lobsters. Show HN wants the story of why you built it. Title: `Show HN: Tradwife – local memory layer for Claude Code and Codex`.

**Ongoing.** Awesome-lists. `awesome-claude-code`, `awesome-ai-agents`, `awesome-devtools`. A PR adding your repo to a relevant awesome-list is the highest-leverage thirty minutes you will spend on distribution.

---

## 7. Sustaining it

**Answer every issue within 24 hours for the first month.** Nothing kills a new repo faster than an unanswered first issue — it tells the next visitor the project is dead.

**Pin one issue** titled `Which phrasings should Tradwife learn?` and invite people to paste the sentences it missed. That turns your weakest point into a contribution funnel, and each reply is free extractor training data.

**Add a demo GIF to the README** once you have one. Record `tradwife show`, then a fresh session where the agent already knows you. A GIF above the fold measurably outperforms a code block.

---

## 8. Honest note on badges

Your draft had a `stars 10k` badge. It is gone from the final README, deliberately.

The first person who checks the star count and sees a different number stops trusting everything else on the page — including the security claims, which are the ones that actually matter here. A repo asking to read every prompt someone types cannot afford a credibility hit over decoration.

The badges that shipped are all verifiable: the CI badge is live and turns red if tests fail, MIT is real, zero dependencies is checkable in `package.json`, and Node ≥18.17 is in `engines`. Add a real star badge once the number is worth showing:

```markdown
<img src="https://img.shields.io/github/stars/ma-nucho-pro/tradwife?style=for-the-badge&color=f2c94c" alt="stars" />
```

That one updates itself and is always true.
