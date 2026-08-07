import path from 'node:path';
import { tradwifeHome } from '../util/paths.js';
import { readJSON, writeJSON } from '../util/fsx.js';
import { normalize } from '../util/text.js';
import { record } from './journal.js';

/**
 * Cross-project promotion.
 *
 * A fact learned in one repo stays in that repo — that is the right default,
 * because most project facts are about the project. But say the same thing in
 * three different repos and it stops being about any of them. "Never commit
 * directly to main" in one codebase is a house rule; the same sentence in your
 * last three codebases is how you work.
 *
 * This ledger is the only piece of state that spans projects. It records which
 * repos a project-scoped fact has shown up in, and once the count crosses the
 * threshold the fact is copied up into identity, where it follows you
 * everywhere. The project copies are left alone: they are still true there.
 */
const ledgerPath = () => path.join(tradwifeHome(), 'cross-project.json');

function load() {
  const raw = readJSON(ledgerPath(), null);
  return raw && typeof raw.facts === 'object' ? raw : { version: 1, facts: {} };
}

/** @returns {boolean} true when this sighting crosses the threshold. */
export function sight({ text, projectKey, threshold = 3 }) {
  if (!projectKey) return false;
  const ledger = load();
  const key = normalize(text);
  if (!key) return false;

  const entry = ledger.facts[key] || { text, projects: [], first: new Date().toISOString(), promoted: false };
  if (!entry.projects.includes(projectKey)) entry.projects.push(projectKey);
  entry.text = text;
  entry.last = new Date().toISOString();
  ledger.facts[key] = entry;

  const crosses = !entry.promoted && entry.projects.length >= threshold;
  if (crosses) entry.promoted = true;
  writeJSON(ledgerPath(), ledger);
  return crosses;
}

/** Facts that have appeared in more than one repo, most widespread first. */
export function spread(minProjects = 2) {
  const ledger = load();
  return Object.values(ledger.facts)
    .filter((e) => e.projects.length >= minProjects)
    .sort((a, b) => b.projects.length - a.projects.length);
}

export function promote(identity, entry, section = 'Working style') {
  const result = identity.upsert({
    text: entry.text,
    section,
    kind: 'rule',
    source: 'explicit',
    confidence: 0.9,
    evidence: `said in ${entry.projects.length} different repos`,
  });
  record({
    event: 'promoted', scope: 'user', text: entry.text,
    reason: `appeared in ${entry.projects.length} separate projects, so it is about you rather than any one repo`,
  });
  return result;
}
