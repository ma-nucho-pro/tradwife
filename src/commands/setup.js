import path from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../core/config.js';
import { openIdentity, openProject, listProjects } from '../core/memory.js';
import { attachClaude, detachClaude, claudeStatus, BIN } from '../agents/claude.js';
import { attachCodex, detachCodex, codexStatus, attachCodexBlock } from '../agents/codex.js';
import { attachCursor, detachCursor, cursorStatus, cursorHome } from '../agents/cursor.js';
import { attachGemini, detachGemini, geminiStatus, geminiHome } from '../agents/gemini.js';
import { listSessions } from '../core/session.js';
import { inspect as inspectGitHub } from '../core/github.js';
import { harvestPending } from '../core/harvest.js';
import { paths, homeRelative, claudeHome, codexHome } from '../util/paths.js';
import { ensureDir, exists, readJSON } from '../util/fsx.js';
import { similarity } from '../util/text.js';
import { say, ok, warn, fail, info, c, heading, bullet, blank } from '../util/out.js';

export function cmdInit(args) {
  const home = paths.home();
  const fresh = !exists(paths.config());
  ensureDir(home);
  ensureDir(paths.sessions());
  ensureDir(paths.projects());

  const config = loadConfig();
  saveConfig(config);
  openIdentity(config).save({ force: true });
  openProject(process.cwd(), config).store.save({ force: true });

  ok(`${fresh ? 'Created' : 'Refreshed'} ${homeRelative(home)}`);
  say(c.gray(`  identity.md     what tradwife knows about you`));
  say(c.gray(`  projects/       one folder per repo you work in`));
  say(c.gray(`  journal.jsonl   append-only audit trail of every change`));

  if (args.claude !== false && exists(claudeHome())) {
    const res = attachClaude();
    ok(`Attached to Claude Code (${res.events.join(', ')})`);
  }
  if (args.codex !== false && exists(codexHome())) {
    attachCodex();
    ok('Attached to Codex (SessionStart, UserPromptSubmit, Stop)');
  }
  if (args.cursor !== false && exists(cursorHome())) {
    attachCursor({ project: true });
    ok('Attached to Cursor (beforeSubmitPrompt, stop)');
  }
  if (args.gemini !== false && exists(geminiHome())) {
    attachGemini();
    ok('Attached to Gemini CLI (injection only — it does not learn from Gemini sessions)');
  }

  blank();
  const gh = inspectGitHub();
  if (gh.canAuto) {
    say(c.bold('Sync across your machines:'));
    say(`  tradwife sync setup      ${c.gray(`# creates ${gh.user}/tradwife-memory, private`)}`);
    blank();
  }
  say(c.bold('Next:'));
  say(`  tradwife remember "I prefer short, implementation-first answers"`);
  say(`  tradwife show`);
  if (!claudeStatus().attached && !codexStatus().attached) {
    say(`  tradwife attach claude   ${c.gray('# or: tradwife attach codex')}`);
  }
  return 0;
}

export function cmdAttach(args) {
  const agent = (args._[0] || '').toLowerCase();
  const project = Boolean(args.project);

  if (agent === 'claude') {
    const res = attachClaude({ project });
    ok(`Claude Code wired up in ${homeRelative(res.file)}`);
    for (const e of res.events) {
      bullet(e, {
        SessionStart: 'loads your memory into the session',
        UserPromptSubmit: 'buffers what you type',
        SessionEnd: 'curates the session into memory',
      }[e]);
    }
    say(c.gray('\nOpen a new Claude Code session; /hooks will list them.'));
    return 0;
  }

  if (agent === 'codex') {
    const res = attachCodex({ project });
    ok(`Codex wired up in ${homeRelative(res.file)}`);
    for (const e of res.events) {
      bullet(e, {
        SessionStart: 'loads your memory into the session',
        UserPromptSubmit: 'buffers what you type',
        Stop: 'curates the session into memory',
        PreToolUse: 'enforces your guards',
      }[e]);
    }
    if (res.flagged) say(c.gray('\nEnabled [features] codex_hooks in config.toml (needed on builds before v0.124).'));
    say(c.gray(`Also wrote the AGENTS.md fallback at ${homeRelative(res.fallback)} for older builds.`));
    say(c.gray('Open a new Codex session; /hooks will list them.'));
    return 0;
  }

  if (agent === 'cursor') {
    const res = attachCursor({ project: true });
    ok(`Cursor wired up in ${homeRelative(res.file)}`);
    for (const e of res.events) {
      bullet(e, {
        beforeSubmitPrompt: 'buffers what you type',
        stop: 'curates the session and refreshes the rules file',
        beforeShellExecution: 'enforces your guards',
      }[e]);
    }
    say(c.gray(`\nMemory is injected through ${homeRelative(res.rules.file)}, rewritten at the end of each session.`));
    say(c.gray('Cursor has no session-start hook that can add context, so it is one session behind on brand new facts.'));
    return 0;
  }

  if (agent === 'gemini') {
    const res = attachGemini({ project });
    ok(`Gemini memory written to ${homeRelative(res.file)}`);
    warn('Injection only: tradwife does not learn from Gemini sessions.');
    say(c.gray('  Refresh it with `tradwife sync-gemini`, or let a Claude Code or Codex'));
    say(c.gray('  session on this machine keep the memory current — they share one store.'));
    return 0;
  }

  fail('Usage: tradwife attach claude|codex|cursor|gemini [--project]');
  return 1;
}

export function cmdDetach(args) {
  const agent = (args._[0] || '').toLowerCase();
  const project = Boolean(args.project);
  if (agent === 'claude') {
    const res = detachClaude({ project });
    if (res.missing) warn(`No settings file at ${homeRelative(res.file)}`);
    else ok(`Removed ${res.removed} tradwife hook(s) from ${homeRelative(res.file)}`);
    return 0;
  }
  if (agent === 'codex') {
    const res = detachCodex({ project });
    ok(`Removed ${res.removed} tradwife hook(s) from ${homeRelative(res.file)} and the AGENTS.md block`);
    return 0;
  }
  if (agent === 'cursor') {
    const res = detachCursor({ project: true });
    ok(`Removed ${res.removed} tradwife hook(s) from ${homeRelative(res.file)}${res.rulesRemoved ? ' and the rules file' : ''}`);
    return 0;
  }
  if (agent === 'gemini') {
    const res = detachGemini({ project });
    if (res.missing || !res.removed) warn('No tradwife block found; nothing to remove.');
    else ok(`Removed tradwife block from ${homeRelative(res.file)}`);
    return 0;
  }
  fail('Usage: tradwife detach claude|codex|cursor|gemini [--project]');
  return 1;
}

/** `tradwife sync` — regenerate anything tradwife writes into another tool's files. */
export function cmdSync(args) {
  if (args.gemini) {
    const res = attachGemini({ project: Boolean(args.project) });
    ok(`Refreshed ${homeRelative(res.file)}`);
    return 0;
  }
  const status = codexStatus({ project: Boolean(args.project) });
  if (!status.attached && !args.force) {
    info('Codex is not attached. Run: tradwife attach codex');
    return 0;
  }
  const res = attachCodexBlock({ project: Boolean(args.project) });
  ok(`Refreshed ${homeRelative(res.file)}`);
  return 0;
}

/**
 * `tradwife doctor` — the health check.
 *
 * Reports near-duplicates, stale facts, budget pressure, orphaned projects and
 * broken wiring. With --fix it applies the safe repairs only, and tells you
 * exactly what it did.
 */
export function cmdDoctor(args) {
  const config = loadConfig();
  const identity = openIdentity(config);
  const project = openProject(process.cwd(), config);
  const problems = [];
  const fixes = [];

  for (const { store, label, budget } of [
    { store: identity, label: 'identity', budget: config.budget.identity },
    { store: project.store, label: `project "${project.name}"`, budget: config.budget.project },
  ]) {
    const facts = store.facts();

    // near-duplicates
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const s = similarity(facts[i].text, facts[j].text);
        if (s >= 0.7) {
          problems.push({
            kind: 'duplicate', label,
            message: `near-duplicate (${Math.round(s * 100)}% overlap) in ${label}:\n      "${facts[i].text}"\n      "${facts[j].text}"`,
            hint: `tradwife forget "${facts[j].text.slice(0, 40)}"`,
          });
        }
      }
    }

    // budget pressure
    const used = store.tokens();
    if (used > budget) {
      problems.push({
        kind: 'budget', label,
        message: `${label} is over budget: ${used}/${budget} tokens`,
        hint: 'tradwife doctor --fix  (prunes the lowest-scoring facts)',
        fixable: true,
        fix: () => {
          const pruned = store.prune(budget);
          store.save();
          return `pruned ${pruned.length} fact(s) from ${label}`;
        },
      });
    } else if (used > budget * 0.9) {
      problems.push({ kind: 'budget', label, message: `${label} is at ${Math.round((used / budget) * 100)}% of its budget`, hint: 'consider pinning what matters and forgetting the rest' });
    }

    // stale
    const cutoff = Date.now() - 180 * 86_400_000;
    const stale = facts.filter((f) => !f.pinned && Date.parse(f.last || 0) < cutoff);
    if (stale.length) {
      problems.push({
        kind: 'stale', label,
        message: `${stale.length} fact(s) in ${label} have not come up in 6 months`,
        hint: `tradwife show --verbose  # lowest scores are the stale ones`,
      });
    }

    // expired pending
    const expired = store.expirePending();
    if (expired) {
      store.save();
      fixes.push(`cleared ${expired} stale candidate(s) from ${label}`);
    }
  }

  // wiring
  const claude = claudeStatus();
  const codex = codexStatus();
  if (!claude.attached && !codex.attached) {
    problems.push({ kind: 'wiring', message: 'no agent is attached, so nothing is being injected or captured', hint: 'tradwife attach claude' });
  }
  if (claude.attached) {
    const settings = readJSON(claude.file, {});
    const handlers = Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks || []);
    const broken = handlers.filter((h) => Array.isArray(h.args) && h.args[0]?.endsWith('tradwife.js') && !exists(h.args[0]));
    if (broken.length) {
      problems.push({
        kind: 'wiring',
        message: `Claude Code points at a tradwife that is no longer there:\n      ${broken[0].args[0]}`,
        hint: 'tradwife attach claude   # re-points it at this checkout',
        fixable: true,
        fix: () => { attachClaude(); return 're-pointed Claude Code hooks at this checkout'; },
      });
    }
  }

  // buffers
  const buffers = listSessions();
  if (buffers.length > 5) {
    problems.push({
      kind: 'buffers',
      message: `${buffers.length} session buffers have not been harvested`,
      hint: 'tradwife harvest',
      fixable: true,
      fix: () => {
        const reports = harvestPending({ config });
        const added = reports.reduce((n, r) => n + r.added.length, 0);
        return `harvested ${reports.length} buffer(s), storing ${added} new fact(s)`;
      },
    });
  }

  // sync health
  const ghState = inspectGitHub();
  if (config.autoSync === true) {
    const stamp = Number(readJSON(paths.config(), {}) && 0) || 0;   // presence check only
    void stamp;
  } else if (ghState.canAuto && !exists(path.join(paths.home(), '.git'))) {
    problems.push({
      kind: 'sync',
      message: 'your memory only exists on this machine, and GitHub is one command away',
      hint: 'tradwife sync setup',
    });
  }

  // orphaned projects
  const orphans = listProjects().filter((p) => !exists(p.root));
  if (orphans.length) {
    problems.push({ kind: 'orphan', message: `${orphans.length} remembered project folder(s) no longer exist`, hint: `rm -rf ${homeRelative(paths.projects())}/<key>` });
  }

  if (args.fix) {
    for (const p of problems.filter((x) => x.fixable)) {
      try { fixes.push(p.fix()); } catch (e) { problems.push({ kind: 'fix-failed', message: `could not fix: ${e.message}` }); }
    }
  }

  heading('tradwife doctor');
  if (!problems.length && !fixes.length) {
    ok('Everything looks healthy.');
    say(c.gray(`  identity ${identity.facts().length} facts · project ${project.store.facts().length} facts · ${buffers.length} buffer(s)`));
    return 0;
  }
  for (const f of fixes) ok(f);
  const remaining = args.fix ? problems.filter((p) => !p.fixable) : problems;
  for (const p of remaining) {
    warn(p.message);
    if (p.hint) say(c.gray(`      → ${p.hint}`));
  }
  if (!args.fix && problems.some((p) => p.fixable)) {
    blank();
    info('Some of these can be fixed automatically: tradwife doctor --fix');
  }
  return remaining.length ? 1 : 0;
}

export function cmdConfig(args) {
  const config = loadConfig();
  if (!args._.length) {
    heading('Config');
    say(JSON.stringify(config, null, 2));
    say(c.gray(`\n  file: ${homeRelative(paths.config())}`));
    return 0;
  }
  const [key, ...rest] = args._;
  const value = rest.join(' ');
  if (!value) {
    say(String(get(config, key)));
    return 0;
  }
  if (!has(DEFAULT_CONFIG, key)) {
    fail(`Unknown setting "${key}". Run \`tradwife config\` to see all of them.`);
    return 1;
  }
  set(config, key, coerce(value));
  saveConfig(config);
  ok(`${key} = ${JSON.stringify(get(config, key))}`);
  return 0;
}

const walk = (obj, key) => key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
const get = walk;
const has = (obj, key) => walk(obj, key) !== undefined;
function set(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let cursor = obj;
  for (const p of parts) cursor = cursor[p] = cursor[p] || {};
  cursor[last] = value;
}
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) { try { return JSON.parse(v); } catch { /* fall through */ } }
  return v;
}

export const _paths = { BIN, path };
