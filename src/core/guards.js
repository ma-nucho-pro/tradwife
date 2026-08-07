import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tradwifeHome } from '../util/paths.js';
import { readJSON, writeJSON } from '../util/fsx.js';
import { normalize, factId } from '../util/text.js';
import { record } from './journal.js';

/**
 * Guards — turning the rules that CAN be enforced into rules that ARE enforced.
 *
 * A fair criticism of context injection: "never commit directly to main" sitting
 * in a prompt is a suggestion. The model usually follows it. Usually is not a
 * guarantee, and a `PreToolUse` hook is.
 *
 * That criticism is right, and it is also narrower than it first appears. Most
 * of what memory holds — "answer in Spanish", "prefers to see the code before
 * the explanation", "works mostly on backend" — corresponds to no tool call at
 * all, so it cannot be a hook by definition. What a hook covers is the subset
 * that maps to an interceptable action.
 *
 * So both, and each doing what it is good at: the guard stops the action, the
 * memory stops the attempt. Without the memory the agent tries the forbidden
 * thing and eats the block every time — deterministic, and a wasted turn each
 * round. Without the guard, "usually" is the best available.
 *
 * Three rules govern this module:
 *
 *   Never generate a guard without asking. Blocking a tool call the user never
 *   asked to block is far worse than not blocking one they did. `tradwife harden`
 *   proposes; nothing is enforced until it is confirmed.
 *
 *   A guard is a pattern, not a sentence. Once approved, the natural language
 *   is only a label. Matching runs against the tool input, identically, always.
 *
 *   Fail open. A guard that crashes must allow the call through. A bug that
 *   blocks every command is a far bigger problem than a rule that missed once.
 */

const guardsPath = () => path.join(tradwifeHome(), 'guards.json');

export function loadGuards() {
  const raw = readJSON(guardsPath(), null);
  return raw && Array.isArray(raw.guards) ? raw : { version: 1, guards: [] };
}

export function saveGuards(state) {
  writeJSON(guardsPath(), state);
  return state;
}

export function activeGuards() {
  return loadGuards().guards.filter((g) => g.enabled !== false);
}

/**
 * Detectors: a stored fact in, a proposed guard out.
 *
 * Each needs two things present in the same sentence — a prohibition and a
 * recognisable action — because "uses pnpm" is a description and "never use
 * npm" is a rule, and only the second should ever block anything.
 */
const FORBIDS = /\b(?:nunca|jam[aá]s|no\s+(?:hagas?|uses?|utilices|borres|elimines|toques|subas|hagais)|evita(?:r)?|never|do\s?n'?t|avoid|no\s+direct)\b/i;

/**
 * Lowercase and de-accent, but keep dots and hyphens.
 *
 * The general normalizer strips punctuation, which turns ".env" into "env" and
 * made the protected-files detector silently unreachable. File names and flags
 * are exactly the things a guard needs to see intact.
 */
const soft = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Split a rule into clauses.
 *
 * "No uses npm, usa pnpm" is one prohibition and one instruction. Scanning the
 * whole sentence at once banned both managers — including the one the user
 * asked for — which would have blocked their actual workflow. Clause boundaries
 * keep the prohibition from leaking across.
 */
const clauses = (t) => soft(t)
  // Split on real clause boundaries and on the words that introduce the
  // alternative ("..., usa pnpm"). "use" and "usa" only count as separators
  // when they are NOT part of the prohibition itself: "never use yarn" is one
  // clause, while "no uses npm, usa pnpm" is two.
  .replace(/\b(?:nunca|never|no|don'?t|do not|avoid|evita)\s+(uses?|usa|utilices|utiliza)\b/g, (m) => m.replace(/\s+/g, '~'))
  .split(/[,;.]|\s+(?:y|pero|sino|and|but|instead|use|usa|utiliza|utilices|uses)\s+/)
  .map((x) => x.replace(/~/g, ' ').trim())
  .filter(Boolean);

const DETECTORS = [
  {
    id: 'git-commit-protected-branch',
    label: 'commit on a protected branch',
    test: (t) => /\bcommit\b/.test(t) && /\b(main|master|produccion|production|prod)\b/.test(t),
    build: (t) => ({
      kind: 'branch',
      tool: 'Bash',
      pattern: '\\bgit\\s+commit\\b',
      branches: [...new Set((soft(t).match(/\b(main|master|produccion|production|prod)\b/g) || ['main']))],
      reason: 'This branch is protected by one of your own rules. Make a branch and open a PR instead.',
    }),
  },
  {
    id: 'git-push-protected-branch',
    label: 'push to a protected branch',
    test: (t) => /\bpush\b/.test(t) && /\b(main|master|produccion|production|prod)\b/.test(t),
    build: (t) => ({
      kind: 'branch',
      tool: 'Bash',
      pattern: '\\bgit\\s+push\\b',
      branches: [...new Set((soft(t).match(/\b(main|master|produccion|production|prod)\b/g) || ['main']))],
      reason: 'Pushing this branch directly is blocked by one of your own rules.',
    }),
  },
  {
    id: 'git-force-push',
    label: 'force push',
    test: (t) => /\b(force[- ]?push|push\s+--?f(orce)?|--force)\b/.test(t),
    build: () => ({
      kind: 'command',
      tool: 'Bash',
      pattern: '\\bgit\\s+push\\b[^;|&]*(?:--force(?!-with-lease)|\\s-f\\b)',
      reason: 'Force pushing is blocked by one of your own rules. --force-with-lease is still allowed.',
    }),
  },
  {
    id: 'package-manager',
    label: 'the wrong package manager',
    test: (t) => /\b(npm|yarn|pnpm|bun)\b/.test(t),
    build: (t) => {
      // Only a manager named inside a clause that forbids something is banned.
      const forbidding = clauses(t).filter((cl) => FORBIDS.test(cl) || /\ben\s+vez\s+de\b|\binstead\s+of\b/.test(cl));
      const banned = ['npm', 'yarn', 'pnpm', 'bun'].filter((m) =>
        forbidding.some((cl) => new RegExp(`\\b${m}\\b`).test(cl)));
      if (!banned.length) return null;
      return {
        kind: 'command',
        tool: 'Bash',
        pattern: `\\b(?:${banned.join('|')})\\s+(?:i|install|add|run|ci|exec|create)\\b`,
        reason: `You told me not to use ${banned.join(' or ')} in this project.`,
      };
    },
  },
  {
    id: 'destructive-rm',
    label: 'recursive delete',
    test: (t) => /\b(rm\s+-rf|borres?|elimines?|delete|borrar\s+archivos)\b/.test(t),
    build: () => ({
      kind: 'command',
      tool: 'Bash',
      pattern: '\\brm\\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\\s+-f|-f\\s+-r)\\b',
      reason: 'Recursive deletes are blocked by one of your own rules. Delete the specific paths instead.',
    }),
  },
  {
    id: 'protected-files',
    label: 'edits to sensitive files',
    test: (t) => /\.env\b|\bsecrets?\b|\bcredenciales\b|\bcredentials\b|\.pem\b/.test(soft(t)),
    build: () => ({
      kind: 'path',
      tools: ['Edit', 'Write', 'NotebookEdit'],
      pattern: '(?:^|/)\\.env(?:\\.|$)|(?:^|/)secrets?\\.|\\.pem$|(?:^|/)credentials(?:\\.|$)',
      reason: 'This file is protected by one of your own rules. Edit it yourself rather than through the agent.',
    }),
  },
  {
    id: 'migrations',
    label: 'running migrations',
    test: (t) => /\b(migrac|migration|migrate)\w*\b/.test(t) && /\b(prod|produccion|production)\b/.test(t),
    build: () => ({
      kind: 'command',
      tool: 'Bash',
      pattern: '\\b(?:migrate|migration)\\b[^;|&]*\\b(?:prod|production)\\b',
      reason: 'Running migrations against production is blocked by one of your own rules.',
    }),
  },
];

/**
 * Which stored facts could be enforced instead of merely suggested.
 * @returns {Array<{fact, detector, guard}>}
 */
export function proposals(facts) {
  const out = [];
  const seen = new Set();
  for (const fact of facts) {
    const t = soft(fact.text);
    if (!FORBIDS.test(t)) continue;   // descriptions are not rules
    for (const d of DETECTORS) {
      if (!d.test(t)) continue;
      const built = d.build(t);
      if (!built) continue;
      const id = factId(`${d.id}:${built.pattern}:${(built.branches || []).join(',')}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ fact, detector: d, guard: { id, from: fact.text, detector: d.id, label: d.label, enabled: true, ...built } });
      break; // one guard per fact: the first detector is the most specific
    }
  }
  return out;
}

export function addGuard(guard) {
  const state = loadGuards();
  if (state.guards.some((g) => g.id === guard.id)) return false;
  state.guards.push({ ...guard, created: new Date().toISOString() });
  saveGuards(state);
  record({ event: 'guard-added', id: guard.id, text: guard.from, reason: `now enforced as a ${guard.kind} guard, not just injected as text` });
  return true;
}

export function removeGuard(id) {
  const state = loadGuards();
  const before = state.guards.length;
  const gone = state.guards.find((g) => g.id === id || g.from?.toLowerCase().includes(String(id).toLowerCase()));
  state.guards = state.guards.filter((g) => g !== gone);
  if (state.guards.length === before) return false;
  saveGuards(state);
  record({ event: 'guard-removed', id: gone.id, text: gone.from });
  return true;
}

function currentBranch(cwd) {
  // `git branch --show-current` first: `rev-parse --abbrev-ref HEAD` fails on a
  // branch with no commits yet, which silently disabled every branch guard in a
  // freshly initialised repo.
  for (const args of [['branch', '--show-current'], ['rev-parse', '--abbrev-ref', 'HEAD']]) {
    try {
      const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2000 });
      const out = (res.stdout || '').trim();
      if (res.status === 0 && out && out !== 'HEAD') return out;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/**
 * Evaluate every guard against one tool call.
 *
 * @param {object} input the PreToolUse payload: { tool_name, tool_input, cwd }
 * @returns {{deny: boolean, guard?: object, reason?: string}}
 */
export function evaluate(input, guards = activeGuards()) {
  const tool = input?.tool_name;
  const args = input?.tool_input || {};
  const command = String(args.command || '');
  const file = String(args.file_path || args.notebook_path || args.path || '');

  for (const g of guards) {
    try {
      const tools = g.tools || [g.tool];
      if (tool && !tools.includes(tool)) continue;
      const re = new RegExp(g.pattern, 'i');

      if (g.kind === 'path') {
        if (file && re.test(file)) return { deny: true, guard: g, reason: g.reason };
        continue;
      }
      if (!command || !re.test(command)) continue;

      if (g.kind === 'branch') {
        // The command alone cannot say which branch you are on, so ask git.
        const branch = currentBranch(input?.cwd || process.cwd());
        if (!branch) continue;                       // no branch, no basis to block
        if (!(g.branches || ['main']).includes(branch.toLowerCase())) continue;
        return { deny: true, guard: g, reason: `${g.reason} (you are on "${branch}")` };
      }
      return { deny: true, guard: g, reason: g.reason };
    } catch {
      // A malformed guard must never block a legitimate call.
      continue;
    }
  }
  return { deny: false };
}

export const _internals = { DETECTORS, FORBIDS, currentBranch };
