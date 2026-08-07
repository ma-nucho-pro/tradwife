import path from 'node:path';
import os from 'node:os';
import { readText, exists } from '../util/fsx.js';
import { claudeHome, codexHome, findProjectRoot } from '../util/paths.js';
import { tidy, titleCase } from '../util/text.js';
import { judge } from './extract.js';
import { detectSecret } from './redact.js';
import { BEGIN, END } from '../agents/codex.js';

/**
 * Import from the instruction files you already maintain.
 *
 * Almost everyone who tries Tradwife already has a CLAUDE.md or an AGENTS.md, and
 * telling them to start from an empty file throws away real work. This reads
 * what they have written and seeds memory from it, so day one is not day zero.
 *
 * Two rules keep it honest.
 *
 * The scope of a file decides the scope of its facts: `~/.claude/CLAUDE.md` is
 * about you and lands in identity; `./CLAUDE.md` is about the repo and lands in
 * project memory. Getting this backwards would drag one project's conventions
 * into every other one.
 *
 * And Tradwife never re-reads its own output. `tradwife sync` writes a managed block
 * into AGENTS.md; importing that back would feed the tool its own memory and
 * inflate confidence on facts nothing new confirmed. The block is stripped
 * before a single line is parsed.
 */

export function sources(cwd = process.cwd()) {
  const root = findProjectRoot(cwd);
  return [
    { file: path.join(claudeHome(), 'CLAUDE.md'), scope: 'user', label: '~/.claude/CLAUDE.md' },
    { file: path.join(os.homedir(), '.claude', 'rules', 'preferences.md'), scope: 'user', label: '~/.claude/rules/preferences.md' },
    { file: path.join(codexHome(), 'AGENTS.md'), scope: 'user', label: '~/.codex/AGENTS.md' },
    { file: path.join(root, 'CLAUDE.md'), scope: 'project', label: './CLAUDE.md' },
    { file: path.join(root, '.claude', 'CLAUDE.md'), scope: 'project', label: './.claude/CLAUDE.md' },
    { file: path.join(root, 'CLAUDE.local.md'), scope: 'project', label: './CLAUDE.local.md' },
    { file: path.join(root, 'AGENTS.md'), scope: 'project', label: './AGENTS.md' },
    { file: path.join(root, 'AGENT.md'), scope: 'project', label: './AGENT.md' },
  ].filter((s) => exists(s.file));
}

/** Remove anything Tradwife itself wrote, so importing can never become a feedback loop. */
export function stripManaged(text) {
  let out = String(text || '');
  for (let i = 0; i < 10; i++) {
    const start = out.indexOf(BEGIN);
    const end = out.indexOf(END);
    if (start === -1 || end === -1 || end < start) break;
    out = out.slice(0, start) + out.slice(end + END.length);
  }
  return out;
}

/** Headings that signal the lines under them are not durable facts. */
const SKIP_HEADINGS = /^(?:table of contents|contents|index|changelog|todo|roadmap|license|installation|install|setup|getting started|commands?|scripts?|api|examples?|troubleshooting|faq)$/i;

/**
 * Pull candidate facts out of an instruction file.
 *
 * Bullets and short standalone imperative lines both count — people write
 * "Always use pnpm" as a bullet in one file and as a bare line in another.
 * Everything goes through the same judge() the live extractor uses, so a
 * credential pasted into a CLAUDE.md is dropped here exactly as it would be
 * mid-session.
 */
export function parseInstructions(raw, { denyPatterns = [] } = {}) {
  const kept = [];
  const skipped = [];
  const text = stripManaged(raw);
  let heading = null;
  let inFence = false;

  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (h) { heading = tidy(h[1], 60); continue; }
    if (heading && SKIP_HEADINGS.test(heading)) continue;

    let candidate = null;
    const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/.exec(line);
    if (bullet) candidate = bullet[1];
    else {
      const bare = line.trim();
      // A short standalone sentence that reads like a rule, not prose.
      if (bare.length >= 8 && bare.length <= 160 && !bare.startsWith('<!--') && !bare.startsWith('|') &&
          !bare.startsWith('>') && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(bare) &&
          /\b(?:always|never|use|prefer|avoid|do not|don'?t|siempre|nunca|usa|usar|prefiere|prefiero|evita|evitar|no uses)\b/i.test(bare)) {
        candidate = bare;
      }
    }
    if (!candidate) continue;

    // Screen for credentials BEFORE any cleanup.
    //
    // Stripping markdown emphasis used to run first, and it removed underscores
    // along with asterisks — which quietly destroyed the exact shape the secret
    // patterns look for. `ghp_abc…` became `ghpabc…` and sailed through. A token
    // pasted into someone's CLAUDE.md would have been imported to disk.
    const secret = detectSecret(candidate, denyPatterns);
    if (secret) {
      skipped.push({ text: '<line containing a credential>', reason: 'looks like a credential', heading });
      continue;
    }

    // Now it is safe to tidy. Asterisks and backticks only: underscores belong to
    // identifiers far more often than to emphasis.
    const clean = tidy(candidate.replace(/[*`]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), 180);
    const verdict = judge(clean, denyPatterns, { allowImperative: true });
    if (!verdict.ok) {
      skipped.push({ text: clean, reason: verdict.reason, heading });
      continue;
    }
    kept.push({ text: titleCase(verdict.text), heading });
  }
  return { kept, skipped };
}

/**
 * @returns {{imported: Array, skipped: Array, files: Array}}
 */
export function importFrom({ identity, project, config, cwd = process.cwd(), dryRun = false }) {
  const imported = [];
  const skipped = [];
  const files = [];
  const seen = new Set();

  for (const src of sources(cwd)) {
    const raw = readText(src.file, null);
    if (raw === null) continue;
    const { kept, skipped: rejected } = parseInstructions(raw, { denyPatterns: config.denyPatterns });
    files.push({ ...src, found: kept.length, rejected: rejected.length });
    for (const r of rejected) skipped.push({ ...r, from: src.label });

    for (const item of kept) {
      const key = `${src.scope}:${item.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const store = src.scope === 'user' ? identity : project;
      const section = src.scope === 'user' ? 'Working style' : 'Conventions';

      if (dryRun) {
        imported.push({ text: item.text, scope: src.scope, from: src.label, action: 'would add' });
        continue;
      }
      const result = store.upsert({
        text: item.text,
        section,
        kind: 'rule',
        source: 'import',
        confidence: 0.9,
        evidence: `imported from ${src.label}`,
      });
      if (result.action !== 'unchanged') {
        imported.push({ text: item.text, scope: src.scope, from: src.label, action: result.action });
      }
    }
  }

  if (!dryRun) {
    identity.prune(config.budget.identity);
    project.prune(config.budget.project);
    identity.save();
    project.save();
  }
  return { imported, skipped, files };
}
