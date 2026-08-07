import { paths } from '../util/paths.js';
import { appendLine, readLines } from '../util/fsx.js';

/**
 * Append-only audit log. Every mutation to memory lands here with enough
 * context to answer "where did this come from?" months later, and nothing is
 * ever destroyed by pruning — evicted facts stay recoverable from the journal.
 */
export function record(event) {
  appendLine(paths.journal(), { at: new Date().toISOString(), ...event });
}

export function readJournal() {
  return readLines(paths.journal());
}

export function findEntries(predicate, limit = 50) {
  const all = readJournal();
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    if (predicate(all[i])) out.push(all[i]);
  }
  return out;
}
