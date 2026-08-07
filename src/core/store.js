import { readText, readJSON, writeAtomic, writeJSON } from '../util/fsx.js';
import { factId, estimateTokens, similarity, refines, contradicts, tidy } from '../util/text.js';
import { record } from './journal.js';

const DAY_MS = 86_400_000;

/**
 * Reserved section name. Facts here are not injected into the agent, but stay
 * visible in the file so you can see what was set aside and why.
 *
 * Making it a section rather than a hidden flag keeps the markdown authoritative:
 * drag a line into `## Dormant` by hand and it stops being injected; drag it out
 * and it comes back. No command needed either way.
 */
export const DORMANT = 'Dormant';

/**
 * A Store is one markdown file plus a metadata sidecar.
 *
 * The markdown file is the source of truth for *what* is remembered. You can
 * open it in any editor and rewrite it; tradwife reads your edits back and keeps
 * them. The sidecar holds the *why* — confidence, how many sessions a fact was
 * seen in, where it came from — because that metadata has no readable place in
 * a bullet list, and burying it in HTML comments would ruin the file for humans.
 *
 * Consequence of that split: markdown always wins. A fact deleted by hand is
 * forgotten on the next load, no command required.
 */
export class Store {
  constructor({ mdPath, indexPath, sections, title, header, halfLife = 90, scope = 'user' }) {
    this.mdPath = mdPath;
    this.indexPath = indexPath;
    this.configuredSections = sections;
    this.title = title;
    this.header = header;
    this.halfLife = halfLife;
    this.scope = scope;
    this.index = { version: 1, facts: {}, pending: {}, updated: null };
    this.order = [];
    this.dirty = false;
  }

  /** Load the index, then reconcile it against whatever the markdown file currently says. */
  load() {
    const stored = readJSON(this.indexPath, null);
    if (stored && typeof stored === 'object') {
      this.index = {
        version: stored.version || 1,
        facts: stored.facts && typeof stored.facts === 'object' ? stored.facts : {},
        pending: stored.pending && typeof stored.pending === 'object' ? stored.pending : {},
        updated: stored.updated || null,
      };
    }
    this.#syncFromMarkdown();
    return this;
  }

  /**
   * Parse the markdown file and make the index match it.
   *  - a bullet with no index entry was typed by hand -> adopt it at full confidence
   *  - an index entry with no bullet was deleted by hand -> forget it
   * If the markdown file does not exist yet, the index is taken as authoritative
   * (first run, or the file was moved) and gets re-rendered on save.
   */
  #syncFromMarkdown() {
    const raw = readText(this.mdPath, null);
    if (raw === null) {
      this.order = Object.keys(this.index.facts);
      this.dirty = true;
      return;
    }

    const parsed = parseMarkdown(raw);
    const seen = new Set();
    const order = [];
    const now = new Date().toISOString();

    for (const { section, text } of parsed) {
      const id = factId(text);
      if (seen.has(id)) continue; // duplicate bullet typed by hand
      seen.add(id);
      order.push(id);
      const existing = this.index.facts[id];
      if (existing) {
        // Keep metadata, but the section shown in the file wins — including a
        // hand-edited move into or out of Dormant.
        if (existing.section !== section) {
          if (section === DORMANT && existing.section !== DORMANT) existing.homeSection = existing.section;
          existing.section = section;
          existing.dormant = section === DORMANT;
          this.dirty = true;
        }
        if (existing.text !== text) {
          existing.text = text;
          this.dirty = true;
        }
      } else {
        this.index.facts[id] = {
          text,
          section,
          kind: 'manual',
          source: 'manual',
          confidence: 1,
          seen: 1,
          sessions: [],
          first: now,
          last: now,
          pinned: false,
          dormant: section === DORMANT,
          evidence: null,
        };
        this.dirty = true;
        record({ event: 'adopted', scope: this.scope, id, text, reason: 'hand-edited file' });
      }
    }

    for (const id of Object.keys(this.index.facts)) {
      if (!seen.has(id)) {
        const fact = this.index.facts[id];
        delete this.index.facts[id];
        this.dirty = true;
        record({ event: 'forgotten', scope: this.scope, id, text: fact.text, reason: 'removed by hand from file' });
      }
    }

    this.order = order;
  }

  facts() {
    const ids = this.order.filter((id) => this.index.facts[id]);
    for (const id of Object.keys(this.index.facts)) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids.map((id) => ({ id, ...this.index.facts[id] }));
  }

  /** Facts that are actually injected. Dormant ones are excluded. */
  activeFacts() {
    return this.facts().filter((f) => !f.dormant);
  }

  dormantFacts() {
    return this.facts().filter((f) => f.dormant);
  }

  get(id) {
    return this.index.facts[id] ? { id, ...this.index.facts[id] } : null;
  }

  /** Exact id match first, then substring, then the closest fuzzy match above 0.5. */
  find(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    if (this.index.facts[q]) return [this.get(q)];
    const all = this.facts();
    const needle = q.toLowerCase();
    const substring = all.filter((f) => f.text.toLowerCase().includes(needle));
    if (substring.length) return substring;
    return all
      .map((f) => ({ f, s: similarity(f.text, q) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f);
  }

  /**
   * score = confidence x recency x repetition, with a bump for facts the user
   * stated on purpose. Only used to decide what gets evicted when a section is
   * over budget, so the exact curve matters less than its ordering.
   */
  score(fact, now = Date.now()) {
    if (fact.pinned) return Number.POSITIVE_INFINITY;
    const ageDays = Math.max(0, (now - Date.parse(fact.last || fact.first || 0)) / DAY_MS);
    const recency = Math.pow(0.5, ageDays / this.halfLife);
    const repetition = 1 + 0.2 * Math.log2(1 + (fact.seen || 1));
    const intent = fact.source === 'manual' || fact.source === 'explicit' ? 1.25 : 1;
    return (fact.confidence || 0.5) * recency * repetition * intent;
  }

  /**
   * Insert or reinforce a fact.
   * Returns { action, id, previous? } where action is one of:
   *   'reinforced' | 'superseded' | 'added' | 'unchanged'
   */
  upsert({ text, section, kind = 'fact', source = 'capture', confidence = 0.7, sessionId = null, evidence = null, seedSessions = null, seedFirst = null }) {
    const clean = tidy(text);
    if (!clean) return { action: 'unchanged', id: null };
    const id = factId(clean);
    const now = new Date().toISOString();

    const existing = this.index.facts[id];
    if (existing) {
      const revived = existing.dormant;
      if (revived) {
        // You said it again, so it is current again. Back to where it lived before.
        existing.dormant = false;
        existing.section = existing.homeSection || section || this.configuredSections[0];
        delete existing.homeSection;
        record({ event: 'revived', scope: this.scope, id, text: clean, reason: 'stated again after going dormant' });
      }
      existing.seen = (existing.seen || 1) + 1;
      existing.last = now;
      existing.confidence = Math.min(0.99, (existing.confidence || confidence) + 0.05);
      if (sessionId && !existing.sessions.includes(sessionId)) existing.sessions.push(sessionId);
      if (existing.sessions.length > 20) existing.sessions = existing.sessions.slice(-20);
      this.dirty = true;
      record({ event: 'reinforced', scope: this.scope, id, text: clean, seen: existing.seen });
      return { action: revived ? 'revived' : 'reinforced', id };
    }

    // Does this replace something already on file?
    for (const [otherId, other] of Object.entries(this.index.facts)) {
      const isContradiction = contradicts(other.text, clean);
      const refinement = refines(other.text, clean); // 1: new refines old, -1: old refines new
      if (!isContradiction && refinement === 0) continue;
      if (other.pinned && !isContradiction) return { action: 'unchanged', id: otherId };

      // Keep whichever statement carries more detail. A contradiction always
      // resolves in favour of the newer statement: you changed your mind.
      const keepIncoming = isContradiction || refinement === 1;
      const winner = keepIncoming ? clean : other.text;
      const winnerId = keepIncoming ? id : otherId;
      if (!keepIncoming) {
        other.seen = (other.seen || 1) + 1;
        other.last = now;
        other.confidence = Math.min(0.99, (other.confidence || confidence) + 0.05);
        if (sessionId && !other.sessions.includes(sessionId)) other.sessions.push(sessionId);
        this.dirty = true;
        record({ event: 'reinforced', scope: this.scope, id: otherId, text: other.text, reason: 'restated less specifically' });
        return { action: 'reinforced', id: otherId };
      }

      delete this.index.facts[otherId];
      this.order = this.order.filter((x) => x !== otherId);
      this.index.facts[winnerId] = {
        text: winner,
        section: section || other.section,
        kind,
        source,
        confidence: Math.max(confidence, other.confidence || 0),
        seen: (other.seen || 1) + 1,
        sessions: sessionId ? [...new Set([...(other.sessions || []), sessionId])].slice(-20) : other.sessions || [],
        first: other.first || now,
        last: now,
        pinned: other.pinned || false,
        evidence: evidence || other.evidence || null,
        supersedes: [...(other.supersedes || []), otherId],
      };
      this.order.push(id);
      this.dirty = true;
      record({
        event: 'superseded',
        scope: this.scope,
        id,
        text: clean,
        replaced: { id: otherId, text: other.text },
        reason: isContradiction ? 'contradiction' : 'more specific restatement',
      });
      return { action: 'superseded', id, previous: other.text };
    }

    // A promoted candidate arrives with the sessions it was seen in. Dropping
    // them would make `tradwife why` claim a fact was confirmed repeatedly while
    // reporting that it was seen once.
    const sessions = [...new Set([...(seedSessions || []), ...(sessionId ? [sessionId] : [])])];
    this.index.facts[id] = {
      text: clean,
      section: section || this.configuredSections[0],
      kind,
      source,
      confidence,
      seen: Math.max(1, sessions.length),
      sessions: sessions.slice(-20),
      first: seedFirst || now,
      last: now,
      pinned: false,
      evidence,
    };
    this.order.push(id);
    this.dirty = true;
    record({ event: 'added', scope: this.scope, id, text: clean, source, kind, evidence });
    return { action: 'added', id };
  }

  remove(id, reason = 'user requested') {
    const fact = this.index.facts[id];
    if (!fact) return false;
    delete this.index.facts[id];
    this.order = this.order.filter((x) => x !== id);
    this.dirty = true;
    record({ event: 'forgotten', scope: this.scope, id, text: fact.text, reason });
    return true;
  }

  setPinned(id, pinned) {
    const fact = this.index.facts[id];
    if (!fact) return false;
    fact.pinned = Boolean(pinned);
    this.dirty = true;
    record({ event: pinned ? 'pinned' : 'unpinned', scope: this.scope, id, text: fact.text });
    return true;
  }

  /**
   * A candidate that is not explicit waits in `pending` until it shows up in
   * `threshold` distinct sessions. This is the single rule that keeps identity
   * from filling with things you mentioned once and never meant.
   */
  stage({ text, section, kind, confidence, sessionId, evidence, threshold = 2 }) {
    const clean = tidy(text);
    if (!clean) return { action: 'unchanged' };
    const id = factId(clean);
    if (this.index.facts[id]) return this.upsert({ text: clean, section, kind, source: 'capture', confidence, sessionId, evidence });

    const now = new Date().toISOString();
    const entry = this.index.pending[id] || {
      text: clean, section, kind, confidence, sessions: [], first: now, evidence,
    };
    if (sessionId && !entry.sessions.includes(sessionId)) entry.sessions.push(sessionId);
    entry.last = now;
    entry.confidence = Math.max(entry.confidence || 0, confidence || 0);
    this.index.pending[id] = entry;
    this.dirty = true;

    if (entry.sessions.length >= threshold) {
      delete this.index.pending[id];
      return this.upsert({
        text: clean, section, kind, source: 'capture',
        confidence: entry.confidence, sessionId, evidence: entry.evidence || evidence,
        seedSessions: entry.sessions, seedFirst: entry.first,
      });
    }
    return { action: 'staged', id, sessions: entry.sessions.length, needed: threshold };
  }

  pending() {
    return Object.entries(this.index.pending).map(([id, v]) => ({ id, ...v }));
  }

  /** Drop pending candidates that never came back, so the sidecar does not grow forever. */
  expirePending(maxAgeDays = 60) {
    const cutoff = Date.now() - maxAgeDays * DAY_MS;
    let removed = 0;
    for (const [id, entry] of Object.entries(this.index.pending)) {
      if (Date.parse(entry.last || entry.first || 0) < cutoff) {
        delete this.index.pending[id];
        removed++;
        this.dirty = true;
      }
    }
    return removed;
  }

  /** Token cost of what actually gets injected. Dormant facts cost nothing. */
  tokens() {
    return estimateTokens(this.activeFacts().map((f) => `- ${f.text}`).join('\n'));
  }

  /**
   * Retire facts you have stopped mentioning.
   *
   * This is the answer to "what happens to something that quietly stops being
   * true?" Contradicting a fact replaces it immediately, and deleting the line
   * forgets it. But a criterion you simply drifted away from used to sit there
   * forever, losing score without anything ever acting on it — decay only bit
   * when the budget filled up, and on a small memory it never did.
   *
   * Now silence is enough. Past the window, a fact goes dormant: out of the
   * injected context, still visible in the file. Say it again and it comes back.
   *
   * Pinned facts never go dormant — that is what pinning is for. Facts you
   * stated deliberately get twice the window, because you meant them once.
   */
  goDormant(windowDays, now = Date.now()) {
    const moved = [];
    for (const fact of this.activeFacts()) {
      if (fact.pinned) continue;
      const deliberate = fact.source === 'manual' || fact.source === 'explicit' || fact.source === 'import';
      const window = deliberate ? windowDays * 2 : windowDays;
      const days = (now - Date.parse(fact.last || fact.first || 0)) / DAY_MS;
      if (days <= window) continue;

      const entry = this.index.facts[fact.id];
      entry.homeSection = entry.section;
      entry.section = DORMANT;
      entry.dormant = true;
      this.dirty = true;
      moved.push({ ...fact, days: Math.round(days) });
      record({
        event: 'dormant', scope: this.scope, id: fact.id, text: fact.text,
        reason: `not mentioned in ${Math.round(days)} days`,
      });
    }
    return moved;
  }

  /** Evict the lowest-scoring facts until the store fits in `budget` tokens. */
  prune(budget) {
    const evicted = [];
    let guard = 0;
    while (this.tokens() > budget && guard++ < 500) {
      const candidates = this.activeFacts()
        .filter((f) => !f.pinned)
        .sort((a, b) => this.score(a) - this.score(b));
      if (!candidates.length) break;
      const victim = candidates[0];
      delete this.index.facts[victim.id];
      this.order = this.order.filter((x) => x !== victim.id);
      this.dirty = true;
      evicted.push(victim);
      record({
        event: 'pruned', scope: this.scope, id: victim.id, text: victim.text,
        score: Number(this.score(victim).toFixed(3)), budget,
        reason: 'over token budget; recoverable from this journal entry',
      });
    }
    return evicted;
  }

  /** Section order: configured sections first, then any extra sections found in the file. */
  sectionNames() {
    const used = new Set(this.facts().map((f) => f.section).filter(Boolean));
    used.delete(DORMANT);
    const ordered = this.configuredSections.filter((s) => used.has(s));
    for (const s of used) if (!ordered.includes(s)) ordered.push(s);
    if (this.dormantFacts().length) ordered.push(DORMANT); // always last
    return ordered;
  }

  render() {
    const lines = [`# ${this.title}`, ''];
    if (this.header) lines.push(this.header, '');
    const all = this.facts();
    if (!all.length) {
      lines.push('_Empty. Add a line with `tradwife remember "..."`, or just type bullets under a `##` heading below._', '');
      for (const s of this.configuredSections) lines.push(`## ${s}`, '');
      return `${lines.join('\n').trimEnd()}\n`;
    }
    for (const section of this.sectionNames()) {
      const items = all.filter((f) => f.section === section);
      if (!items.length) continue;
      items.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      lines.push(`## ${section}`);
      if (section === DORMANT) {
        lines.push('_Not mentioned in a long time, so these are no longer sent to the agent._');
        lines.push('_Say one again and it comes back. Delete the line to forget it for good._');
      }
      for (const f of items) lines.push(`- ${f.text}`);
      lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }

  save({ force = false } = {}) {
    if (!this.dirty && !force) return false;
    this.index.updated = new Date().toISOString();
    writeAtomic(this.mdPath, this.render());
    writeJSON(this.indexPath, this.index);
    this.dirty = false;
    return true;
  }
}

/** Extract `## Section` / `- bullet` pairs. Prose, quotes and comments are ignored. */
export function parseMarkdown(raw) {
  const out = [];
  let section = null;
  for (const line of String(raw).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const bullet = /^[-*]\s+(.+?)\s*$/.exec(line);
    if (bullet && section) {
      const text = tidy(bullet[1]);
      if (text && !text.startsWith('_')) out.push({ section, text });
    }
  }
  return out;
}
