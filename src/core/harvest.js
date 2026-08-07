import { extract } from './extract.js';
import { loadConfig } from './config.js';
import { openIdentity, openProject } from './memory.js';
import { readSession, dropSession, listSessions } from './session.js';
import { record } from './journal.js';
import { sep } from 'node:path';
import { sight, spread, promote } from './crossproject.js';

/**
 * The curator. Everything upstream of here is plumbing; this is where the
 * product lives.
 *
 * Four steps, in order:
 *   1. extract  - pull candidate facts out of what you actually typed
 *   2. gate     - explicit statements land now, everything else waits for a
 *                 second sighting in a different session
 *   3. reconcile- handled inside Store.upsert: reinforce, supersede on
 *                 contradiction, or add
 *   4. prune    - enforce the token budget, lowest score first
 *
 * Step 2 and step 4 are the ones competitors skip, and they are the reason
 * their memory files fill with contradictions nobody trusts.
 */
export function harvestSession(sessionId, { config = loadConfig(), identity = null } = {}) {
  const entries = readSession(sessionId);
  const report = {
    sessionId,
    prompts: entries.length,
    added: [], reinforced: [], superseded: [], staged: [], rejected: [], pruned: [],
    dormant: [], revived: [], promoted: [],
    stores: new Set(),
  };
  if (!entries.length) {
    dropSession(sessionId);
    return finish(report, []);
  }

  const id = identity || openIdentity(config);
  const projectCache = new Map();
  const touched = new Set([id]);

  // `startsWith` alone would treat /work/api-old as living inside /work/api.
  const under = (cwd, root) => cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
  const projectFor = (cwd) => {
    const opened = [...projectCache.values()].find((p) => cwd && under(cwd, p.root));
    if (opened) return opened;
    const p = openProject(cwd || process.cwd(), config);
    if (projectCache.has(p.key)) return projectCache.get(p.key);
    projectCache.set(p.key, p);
    touched.add(p.store);
    return p;
  };

  for (const entry of entries) {
    const { candidates, rejected } = extract(entry.prompt, {
      denyPatterns: config.denyPatterns,
      maxChars: config.maxPromptChars,
    });
    for (const r of rejected) report.rejected.push(r);

    for (const c of candidates) {
      const target = c.scope === 'user' ? id : projectFor(entry.cwd).store;
      const label = c.scope === 'user' ? 'identity' : projectFor(entry.cwd).name;
      report.stores.add(label);

      const payload = {
        text: c.text, section: c.section, kind: c.kind,
        confidence: c.confidence, sessionId, evidence: c.evidence,
      };

      const result = c.explicit
        ? target.upsert({ ...payload, source: 'explicit' })
        : target.stage({ ...payload, threshold: config.promotionThreshold });

      // A project fact seen in enough separate repos is really about the person.
      if (c.scope !== 'user' && (result.action === 'added' || result.action === 'reinforced')) {
        const p = projectFor(entry.cwd);
        if (sight({ text: c.text, projectKey: p.key, threshold: config.crossProjectThreshold })) {
          const up = promote(id, spread(config.crossProjectThreshold).find((e) => e.text === c.text) || { text: c.text, projects: [] });
          if (up.action !== 'unchanged') report.promoted.push({ text: c.text });
        }
      }

      if (result.action === 'added') report.added.push({ ...c, store: label });
      else if (result.action === 'reinforced') report.reinforced.push({ ...c, store: label });
      else if (result.action === 'revived') report.revived.push({ ...c, store: label });
      else if (result.action === 'superseded') report.superseded.push({ ...c, store: label, previous: result.previous });
      else if (result.action === 'staged') report.staged.push({ ...c, store: label, sessions: result.sessions, needed: result.needed });
    }
  }

  for (const store of touched) {
    const isUser = store.scope === 'user';
    const budget = isUser ? config.budget.identity : config.budget.project;
    const window = isUser ? config.dormancy.identity : config.dormancy.project;
    for (const gone of store.goDormant(window)) report.dormant.push({ text: gone.text, days: gone.days, store: store.scope });
    for (const evicted of store.prune(budget)) report.pruned.push({ text: evicted.text, store: store.scope });
    store.expirePending();
    store.save();
  }

  dropSession(sessionId);
  return finish(report, [...touched]);
}

function finish(report, touched) {
  report.stores = [...report.stores];
  record({
    event: 'harvest',
    session: report.sessionId,
    prompts: report.prompts,
    added: report.added.length,
    reinforced: report.reinforced.length,
    superseded: report.superseded.length,
    staged: report.staged.length,
    pruned: report.pruned.length,
    rejected: report.rejected.length,
  });
  report.touched = touched.length;
  return report;
}

/**
 * Harvest every buffered session except the one currently running.
 *
 * This is what makes tradwife crash-proof: if the agent is killed, the machine
 * loses power, or SessionEnd never fires, the buffer is simply picked up at the
 * start of the next session. SessionEnd is an optimisation, not a requirement.
 */
export function harvestPending({ config = loadConfig(), exclude = null } = {}) {
  const reports = [];
  const identity = openIdentity(config);
  for (const sessionId of listSessions()) {
    if (exclude && sessionId === exclude) continue;
    reports.push(harvestSession(sessionId, { config, identity }));
  }
  return reports;
}
