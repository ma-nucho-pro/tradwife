import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHome, findProjectRoot } from '../util/paths.js';
import { readText, readJSON, writeJSON, writeAtomic, exists, ensureDir } from '../util/fsx.js';
import { compileContext } from '../core/compile.js';
import { activeGuards } from '../core/guards.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(HERE, '..', '..', 'bin', 'tradwife.js');

export const BEGIN = '<!-- tradwife:begin — managed block, edited by `tradwife sync-codex`. Your own text is safe outside it. -->';
export const END = '<!-- tradwife:end -->';

/**
 * Codex CLI integration.
 *
 * Codex's hook engine went stable in v0.124.0 and uses the same event names as
 * Claude Code — SessionStart, UserPromptSubmit, PreToolUse — so tradwife's existing
 * lifecycle commands work unchanged. Three differences are load-bearing:
 *
 *   - the session ends on `Stop`, not `SessionEnd`
 *   - a PreToolUse hook blocks by exiting 2 with the reason on stderr, where
 *     Claude Code expects a permissionDecision object on stdout
 *   - older builds need `[features] codex_hooks = true` in config.toml
 *
 * The AGENTS.md block is kept as a fallback for versions predating the hook
 * engine. It only injects; it never learns.
 */

export function hooksPath({ project = false, cwd = process.cwd() } = {}) {
  return project
    ? path.join(findProjectRoot(cwd), '.codex', 'hooks.json')
    : path.join(codexHome(), 'hooks.json');
}

export function agentsPath({ project = false, cwd = process.cwd() } = {}) {
  return project ? path.join(findProjectRoot(cwd), 'AGENTS.md') : path.join(codexHome(), 'AGENTS.md');
}

export function codexHooks(nodeBin = process.execPath) {
  const cmd = (args) => `"${nodeBin}" "${BIN}" ${args}`;
  const hooks = {
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: cmd('inject --agent codex'), timeout: 15, statusMessage: 'Loading tradwife memory' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('capture --agent codex'), timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd('harvest --stdin --quiet'), timeout: 30 }] }],
  };
  if (hasGuards()) {
    hooks.PreToolUse = [{ matcher: '.*', hooks: [{ type: 'command', command: cmd('guard --style codex'), timeout: 10 }] }];
  }
  return hooks;
}

const hasGuards = () => { try { return activeGuards().length > 0; } catch { return false; } };

export function isTradwifeHandler(handler) {
  const c = typeof handler?.command === 'string' ? handler.command : '';
  return /tradwife\.js/.test(c);
}

/**
 * Older Codex builds gate the hook engine behind a feature flag. Appending it
 * is harmless on versions where hooks are already stable, and without it the
 * hooks are silently ignored on the versions that still need it.
 */
function ensureFeatureFlag() {
  const file = path.join(codexHome(), 'config.toml');
  const current = readText(file, '');
  if (/codex_hooks\s*=\s*true/.test(current)) return false;
  ensureDir(path.dirname(file));
  const block = '\n[features]\ncodex_hooks = true\n';
  if (/^\[features\]/m.test(current)) {
    // Anchor tightly: `^\s*` swallowed the blank line above the table and
    // reformatted the user's config for no reason. Touch only the line itself.
    writeAtomic(file, current.replace(/^\[features\][ \t]*$/m, '[features]\ncodex_hooks = true'));
  } else {
    writeAtomic(file, `${current.trimEnd()}${current.trim() ? '\n' : ''}${block}`);
  }
  return true;
}

export function attachCodex({ project = false, cwd = process.cwd(), nodeBin = process.execPath, includeProject = true } = {}) {
  const file = hooksPath({ project, cwd });
  ensureDir(path.dirname(file));
  const existing = readJSON(file, null) || { version: 1, hooks: {} };
  existing.hooks = existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {};

  const wanted = codexHooks(nodeBin);
  const events = [];
  for (const [event, groups] of Object.entries(wanted)) {
    const prior = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
    const cleaned = prior
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isTradwifeHandler(h)) }))
      .filter((g) => (g.hooks || []).length > 0);
    existing.hooks[event] = [...cleaned, ...groups];
    events.push(event);
  }
  existing.version = existing.version || 1;
  writeJSON(file, existing);

  const flagged = ensureFeatureFlag();
  const fallback = attachCodexBlock({ project, cwd, includeProject });
  return { file, events, flagged, fallback: fallback.file };
}

export function detachCodex({ project = false, cwd = process.cwd() } = {}) {
  const file = hooksPath({ project, cwd });
  let removed = 0;
  const existing = readJSON(file, null);
  if (existing?.hooks) {
    for (const [event, groups] of Object.entries(existing.hooks)) {
      if (!Array.isArray(groups)) continue;
      const cleaned = groups
        .map((g) => {
          const kept = (g.hooks || []).filter((h) => { if (isTradwifeHandler(h)) { removed++; return false; } return true; });
          return { ...g, hooks: kept };
        })
        .filter((g) => (g.hooks || []).length > 0);
      if (cleaned.length) existing.hooks[event] = cleaned;
      else delete existing.hooks[event];
    }
    writeJSON(file, existing);
  }
  const block = detachCodexBlock({ project, cwd });
  return { file, removed, missing: !existing, block: block.file };
}

export function codexStatus({ project = false, cwd = process.cwd() } = {}) {
  const file = hooksPath({ project, cwd });
  const existing = readJSON(file, null);
  const events = existing?.hooks
    ? Object.entries(existing.hooks)
        .filter(([, g]) => Array.isArray(g) && g.some((x) => (x.hooks || []).some(isTradwifeHandler)))
        .map(([e]) => e)
    : [];
  const md = readText(agentsPath({ project, cwd }), null);
  return { file, attached: events.length > 0, events, blockOnly: events.length === 0 && Boolean(md && md.includes(BEGIN)) };
}

/* ---- AGENTS.md fallback, for builds older than the hook engine ---- */

export function renderBlock({ cwd = process.cwd(), includeProject = true } = {}) {
  const { text, empty } = compileContext({ cwd, includeProject });
  const body = empty
    ? '_No memory recorded yet. Run `tradwife remember "..."` or let tradwife learn from your prompts._'
    : text.trim();
  return [BEGIN, '', body, '', `_Regenerate with \`tradwife sync-codex\`. Last updated ${new Date().toISOString().slice(0, 10)}._`, '', END].join('\n');
}

export function upsertBlock(existing, block) {
  const current = existing || '';
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
  }
  const prefix = current.trim() ? `${current.trimEnd()}\n\n` : '';
  return `${prefix}${block}\n`;
}

export function attachCodexBlock({ project = false, cwd = process.cwd(), includeProject = true } = {}) {
  const file = agentsPath({ project, cwd });
  ensureDir(path.dirname(file));
  const existed = exists(file);
  const next = upsertBlock(readText(file, ''), renderBlock({ cwd, includeProject }));
  writeAtomic(file, next.endsWith('\n') ? next : `${next}\n`);
  return { file, existed, bytes: next.length };
}

export function detachCodexBlock({ project = false, cwd = process.cwd() } = {}) {
  const file = agentsPath({ project, cwd });
  if (!exists(file)) return { file, removed: false, missing: true };
  const current = readText(file, '');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) return { file, removed: false, missing: false };
  const next = `${current.slice(0, start).trimEnd()}\n${current.slice(end + END.length).trimStart()}`;
  writeAtomic(file, next.trim() ? next : '');
  return { file, removed: true, missing: false };
}
