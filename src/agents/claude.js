import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome } from '../util/paths.js';
import { readJSON, writeJSON, exists, ensureDir } from '../util/fsx.js';
import { activeGuards } from '../core/guards.js';

const hasGuards = () => { try { return activeGuards().length > 0; } catch { return false; } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(HERE, '..', '..', 'bin', 'tradwife.js');

/**
 * Hooks are registered in exec form (`command` + `args`) with an absolute path
 * to this checkout, run through the same node binary that installed it. That
 * sidesteps the two things that break hook setups in practice: a PATH that does
 * not include the npm global bin directory, and shell quoting on paths with
 * spaces.
 *
 * Timeouts are not decorative. SessionEnd hooks share a 1.5 second budget
 * unless a handler asks for more, and harvesting a long session can exceed
 * that, so the SessionEnd entry declares 20s explicitly.
 */
export function tradwifeHooks(nodeBin = process.execPath) {
  const handler = (args, extra = {}) => ({ type: 'command', command: nodeBin, args: [BIN, ...args], ...extra });
  const hooks = {
    SessionStart: [{ hooks: [handler(['inject', '--agent', 'claude'], { timeout: 15, statusMessage: 'Loading tradwife memory' })] }],
    UserPromptSubmit: [{ hooks: [handler(['capture', '--agent', 'claude'], { timeout: 10 })] }],
    SessionEnd: [{ hooks: [handler(['harvest', '--stdin'], { timeout: 20 })] }],
  };

  // PreToolUse is only registered once there is something to enforce. Adding a
  // hook that runs on every tool call and never blocks anything is pure latency,
  // and it puts tradwife in the path of work it has no business touching.
  if (hasGuards()) {
    hooks.PreToolUse = [{ matcher: 'Bash|Edit|Write|NotebookEdit', hooks: [handler(['guard'], { timeout: 8 })] }];
  }
  return hooks;
}

export function isTradwifeHandler(handler) {
  if (!handler || typeof handler !== 'object') return false;
  const args = Array.isArray(handler.args) ? handler.args : [];
  const inArgs = args.some((a) => typeof a === 'string' && /(?:^|[\\/])tradwife\.js$/.test(a));
  const inCommand = typeof handler.command === 'string' && /tradwife(?:\.js)?["']?\s|tradwife\.js$/.test(handler.command);
  return inArgs || inCommand;
}

export function settingsPath({ project = false, cwd = process.cwd() } = {}) {
  return project ? path.join(cwd, '.claude', 'settings.json') : path.join(claudeHome(), 'settings.json');
}

/**
 * Merge tradwife's hooks into an existing settings file without disturbing
 * anything else in it. Re-running attach is a no-op, not a duplicate.
 */
export function attachClaude({ project = false, cwd = process.cwd(), nodeBin = process.execPath } = {}) {
  const file = settingsPath({ project, cwd });
  ensureDir(path.dirname(file));
  const settings = readJSON(file, null) || {};
  const before = JSON.stringify(settings);

  settings.hooks = settings.hooks || {};
  const wanted = tradwifeHooks(nodeBin);
  const events = [];

  for (const [event, groups] of Object.entries(wanted)) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = existing
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isTradwifeHandler(h)) }))
      .filter((group) => (group.hooks || []).length > 0);
    settings.hooks[event] = [...cleaned, ...groups];
    events.push(event);
  }

  writeJSON(file, settings);
  return { file, events, changed: before !== JSON.stringify(settings), existed: before !== '{}' };
}

export function detachClaude({ project = false, cwd = process.cwd() } = {}) {
  const file = settingsPath({ project, cwd });
  if (!exists(file)) return { file, removed: 0, missing: true };
  const settings = readJSON(file, null) || {};
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((group) => {
        const kept = (group.hooks || []).filter((h) => {
          if (isTradwifeHandler(h)) { removed++; return false; }
          return true;
        });
        return { ...group, hooks: kept };
      })
      .filter((group) => (group.hooks || []).length > 0);
    if (cleaned.length) settings.hooks[event] = cleaned;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJSON(file, settings);
  return { file, removed, missing: false };
}

export function claudeStatus({ project = false, cwd = process.cwd() } = {}) {
  const file = settingsPath({ project, cwd });
  const settings = readJSON(file, null);
  if (!settings) return { file, attached: false, events: [] };
  const events = Object.entries(settings.hooks || {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((g) => (g.hooks || []).some(isTradwifeHandler)))
    .map(([event]) => event);
  return { file, attached: events.length > 0, events };
}
