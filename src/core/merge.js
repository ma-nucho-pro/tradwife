import { normalize } from '../util/text.js';

/**
 * Semantic merge, for people who work on more than one machine.
 *
 * The usual advice — push your memory folder to a private repo — works right up
 * to the moment you use two machines in the same week. Then git hands you a
 * text conflict in a file full of facts and asks you to pick a side, and every
 * side loses something.
 *
 * Facts are content-addressed and carry their own provenance, so they can be
 * merged by meaning instead of by line. Nothing here is new: these are the same
 * reconciliation rules `Store.upsert` already applies within one machine,
 * pointed at two copies of the same memory instead.
 *
 * Nothing about this is limited to two machines. A fact merges by union, so
 * seven laptops converge exactly as cleanly as two.
 *
 * The rules, in the order they are applied to each fact id:
 *
 *   in both        union the sessions, keep the highest seen count and the
 *                  latest sighting. Pinned wins over unpinned, and awake wins
 *                  over dormant: both are deliberate acts, and reviving
 *                  something on one machine should not be undone by the other
 *                  having been quiet.
 *
 *   only one side, and it was in the common ancestor
 *                  the other machine deleted it. Deletion wins. Removing a
 *                  fact is a decision the user made on purpose; silently
 *                  resurrecting it is the single most annoying thing a sync
 *                  can do.
 *
 *   only one side, and it was NOT in the ancestor
 *                  that machine learned something new. Keep it.
 */

const newer = (a, b) => (Date.parse(a || 0) >= Date.parse(b || 0) ? a : b);
const older = (a, b) => (Date.parse(a || 0) <= Date.parse(b || 0) ? a : b);

function mergeFact(ours, theirs) {
  const sessions = [...new Set([...(ours.sessions || []), ...(theirs.sessions || [])])].slice(-20);
  return {
    ...ours,
    // The other machine may hold a longer or shorter form of the same statement.
    // Prefer whichever was confirmed most recently.
    text: Date.parse(theirs.last || 0) > Date.parse(ours.last || 0) ? theirs.text : ours.text,
    section: Date.parse(theirs.last || 0) > Date.parse(ours.last || 0) ? theirs.section : ours.section,
    seen: Math.max(ours.seen || 1, theirs.seen || 1, sessions.length),
    sessions,
    confidence: Math.max(ours.confidence || 0, theirs.confidence || 0),
    first: older(ours.first, theirs.first),
    last: newer(ours.last, theirs.last),
    pinned: Boolean(ours.pinned || theirs.pinned),
    dormant: Boolean(ours.dormant && theirs.dormant),
    homeSection: ours.homeSection || theirs.homeSection,
    evidence: ours.evidence || theirs.evidence,
    supersedes: [...new Set([...(ours.supersedes || []), ...(theirs.supersedes || [])])],
  };
}

/**
 * Merge pending candidates.
 *
 * This is the quiet win of syncing. The promotion gate asks for a fact to turn
 * up in two separate sessions, and until now those sessions had to be on the
 * same machine. Union the session lists and saying something once on the laptop
 * and once on the desktop is finally enough.
 */
function mergePending(ours = {}, theirs = {}, facts) {
  const out = {};
  for (const id of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (facts[id]) continue; // already promoted on one side; the candidate is spent
    const a = ours[id];
    const b = theirs[id];
    if (!a || !b) { out[id] = a || b; continue; }
    out[id] = {
      ...a,
      sessions: [...new Set([...(a.sessions || []), ...(b.sessions || [])])],
      confidence: Math.max(a.confidence || 0, b.confidence || 0),
      first: older(a.first, b.first),
      last: newer(a.last, b.last),
    };
  }
  return out;
}

/**
 * Three-way merge of two index files.
 * @param {object|null} base the common ancestor, or null for a two-way merge
 * @returns {{index: object, stats: object}}
 */
export function mergeIndex(base, ours, theirs) {
  const B = base?.facts || {};
  const O = ours?.facts || {};
  const T = theirs?.facts || {};
  const stats = { merged: 0, fromThem: 0, fromUs: 0, deleted: 0, kept: 0 };
  const facts = {};

  for (const id of new Set([...Object.keys(O), ...Object.keys(T)])) {
    const inOurs = Object.hasOwn(O, id);
    const inTheirs = Object.hasOwn(T, id);
    const inBase = Object.hasOwn(B, id);

    if (inOurs && inTheirs) {
      facts[id] = mergeFact(O[id], T[id]);
      stats.merged++;
    } else if (inBase) {
      // Present in the ancestor, gone from one side: that side deleted it.
      stats.deleted++;
    } else if (inTheirs) {
      facts[id] = T[id];
      stats.fromThem++;
    } else {
      facts[id] = O[id];
      stats.fromUs++;
    }
  }
  stats.kept = Object.keys(facts).length;

  return {
    index: {
      version: ours?.version || theirs?.version || 1,
      facts,
      pending: mergePending(ours?.pending, theirs?.pending, facts),
      updated: newer(ours?.updated, theirs?.updated),
    },
    stats,
  };
}

/** Merge the cross-project ledger: a fact's repo list is the union of both sides. */
export function mergeLedger(base, ours, theirs) {
  const O = ours?.facts || {};
  const T = theirs?.facts || {};
  const facts = {};
  for (const key of new Set([...Object.keys(O), ...Object.keys(T)])) {
    const a = O[key];
    const b = T[key];
    if (!a || !b) { facts[key] = a || b; continue; }
    facts[key] = {
      text: Date.parse(b.last || 0) > Date.parse(a.last || 0) ? b.text : a.text,
      projects: [...new Set([...(a.projects || []), ...(b.projects || [])])],
      first: older(a.first, b.first),
      last: newer(a.last, b.last),
      promoted: Boolean(a.promoted || b.promoted),
    };
  }
  return { version: ours?.version || 1, facts };
}

/**
 * Merge the audit log. It is append-only by construction, so the union of both
 * sides in timestamp order is the whole history, with exact duplicates dropped.
 */
export function mergeJournal(ourLines, theirLines) {
  const seen = new Set();
  const all = [];
  for (const line of [...ourLines, ...theirLines]) {
    const key = JSON.stringify(line);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(line);
  }
  return all.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

export const _internals = { mergeFact, mergePending, normalize };
