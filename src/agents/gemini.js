import path from 'node:path';
import os from 'node:os';
import { readText, writeAtomic, exists, ensureDir } from '../util/fsx.js';
import { findProjectRoot } from '../util/paths.js';
import { compileContext } from '../core/compile.js';

export const BEGIN = '<!-- tradwife:begin — managed block, refreshed by `tradwife sync-gemini`. Your own text is safe outside it. -->';
export const END = '<!-- tradwife:end -->';

/**
 * Gemini CLI integration — injection only, and deliberately so.
 *
 * Gemini CLI does have a hook engine (on by default since v0.26.0, configured
 * in .gemini/settings.json), but its event names and the exact output schema
 * for adding context are not something this integration can rely on without
 * guessing, and a hook wired to the wrong event name fails silently — which is
 * the worst possible outcome for a memory tool.
 *
 * So this writes GEMINI.md, which Gemini CLI loads as context on every session
 * and which is stable across versions. Memory reaches the model; tradwife does not
 * learn from Gemini sessions. Refresh it with `tradwife sync-gemini`, or let a
 * Claude Code or Codex session on the same machine keep the memory current —
 * they share one store.
 */

export function geminiHome() {
  return process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

export function geminiPath({ project = false, cwd = process.cwd() } = {}) {
  return project ? path.join(findProjectRoot(cwd), 'GEMINI.md') : path.join(geminiHome(), 'GEMINI.md');
}

export function renderBlock({ cwd = process.cwd() } = {}) {
  const { text, empty } = compileContext({ cwd });
  const body = empty ? '_No memory recorded yet._' : text.trim();
  return [BEGIN, '', body, '', `_Refresh with \`tradwife sync-gemini\`. Last updated ${new Date().toISOString().slice(0, 10)}._`, '', END].join('\n');
}

export function upsertBlock(existing, block) {
  const current = existing || '';
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
  const prefix = current.trim() ? `${current.trimEnd()}\n\n` : '';
  return `${prefix}${block}\n`;
}

export function attachGemini({ project = false, cwd = process.cwd() } = {}) {
  const file = geminiPath({ project, cwd });
  ensureDir(path.dirname(file));
  const existed = exists(file);
  const next = upsertBlock(readText(file, ''), renderBlock({ cwd }));
  writeAtomic(file, next.endsWith('\n') ? next : `${next}\n`);
  return { file, existed, injectionOnly: true };
}

export function detachGemini({ project = false, cwd = process.cwd() } = {}) {
  const file = geminiPath({ project, cwd });
  if (!exists(file)) return { file, removed: false, missing: true };
  const current = readText(file, '');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) return { file, removed: false, missing: false };
  const next = `${current.slice(0, start).trimEnd()}\n${current.slice(end + END.length).trimStart()}`;
  writeAtomic(file, next.trim() ? next : '');
  return { file, removed: true, missing: false };
}

export function geminiStatus({ project = false, cwd = process.cwd() } = {}) {
  const file = geminiPath({ project, cwd });
  const current = readText(file, null);
  return { file, attached: Boolean(current && current.includes(BEGIN)), injectionOnly: true };
}
