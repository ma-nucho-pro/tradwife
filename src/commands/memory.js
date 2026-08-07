import { loadConfig } from '../core/config.js';
import { openIdentity, openProject } from '../core/memory.js';
import { findEntries } from '../core/journal.js';
import { judge } from '../core/extract.js';
import { ok, fail, warn, say, info, c, bullet, heading, plural } from '../util/out.js';

function pickStore(args, config = loadConfig()) {
  const scope = args.project ? 'project' : args.user ? 'user' : args.scope || 'user';
  if (scope === 'project') {
    const p = openProject(process.cwd(), config);
    return { store: p.store, label: `project "${p.name}"`, config, scope: 'project' };
  }
  return { store: openIdentity(config), label: 'identity', config, scope: 'user' };
}

/** `tradwife remember "<fact>"` — the manual override. Always trusted, never staged. */
export function cmdRemember(args) {
  const text = args._.join(' ').trim();
  if (!text) {
    fail('Nothing to remember. Try: tradwife remember "I prefer short answers"');
    return 1;
  }
  const config = loadConfig();
  const verdict = judge(text, config.denyPatterns);
  if (!verdict.ok && verdict.reason.includes('credential')) {
    fail('That looks like a credential. tradwife will not store it.');
    return 1;
  }

  const { store, label, scope } = pickStore(args, config);
  const section = args.section || (scope === 'user' ? 'Who' : 'Decisions');
  const result = store.upsert({
    text, section, kind: 'manual', source: 'manual', confidence: 1,
    evidence: 'stated directly with `tradwife remember`',
  });

  const budget = scope === 'user' ? config.budget.identity : config.budget.project;
  const pruned = store.prune(budget);
  store.save();

  if (result.action === 'reinforced') info(`Already in ${label}. Confidence raised.`);
  else if (result.action === 'superseded') ok(`Updated ${label}: replaced "${result.previous}"`);
  else ok(`Added to ${label} under "${section}".`);
  if (pruned.length) warn(`Budget reached; dropped ${pruned.length} lower-value fact(s). See \`tradwife journal\`.`);
  return 0;
}

/** `tradwife forget "<text or id>"` — removes the line entirely. No softening. */
export function cmdForget(args) {
  const query = args._.join(' ').trim();
  if (!query) {
    fail('Nothing to forget. Try: tradwife forget "short answers"');
    return 1;
  }
  const config = loadConfig();
  const targets = [
    { store: openIdentity(config), label: 'identity' },
    { store: openProject(process.cwd(), config).store, label: 'this project' },
  ];

  const matches = [];
  for (const t of targets) {
    for (const f of t.store.find(query)) matches.push({ ...t, fact: f });
  }

  if (!matches.length) {
    warn(`No stored fact matches "${query}".`);
    return 1;
  }
  if (matches.length > 1 && !args.all) {
    warn(`"${query}" matches ${matches.length} facts. Be more specific, or pass --all:`);
    for (const m of matches) bullet(m.fact.text, `[${m.label}]`);
    return 1;
  }

  for (const m of matches) {
    m.store.remove(m.fact.id, 'user ran `tradwife forget`');
    m.store.save();
    ok(`Forgotten from ${m.label}: "${m.fact.text}"`);
  }
  say(c.gray('The journal keeps a dated record that it was removed, and why.'));
  return 0;
}

/** `tradwife pin "<text>"` — exempt a fact from decay and from budget eviction. */
export function cmdPin(args, { unpin = false } = {}) {
  const query = args._.join(' ').trim();
  if (!query) {
    fail(`Usage: tradwife ${unpin ? 'unpin' : 'pin'} "<text>"`);
    return 1;
  }
  const config = loadConfig();
  for (const { store, label } of [
    { store: openIdentity(config), label: 'identity' },
    { store: openProject(process.cwd(), config).store, label: 'this project' },
  ]) {
    const [fact] = store.find(query);
    if (!fact) continue;
    store.setPinned(fact.id, !unpin);
    store.save();
    ok(`${unpin ? 'Unpinned' : 'Pinned'} in ${label}: "${fact.text}"`);
    if (!unpin) say(c.gray('Pinned facts never decay and are never evicted by the budget.'));
    return 0;
  }
  warn(`No stored fact matches "${query}".`);
  return 1;
}

/**
 * `tradwife why "<text>"` — the trust command.
 *
 * Answers "where did this come from?" from the journal: when it was first
 * recorded, what you had typed at the time, how many sessions confirmed it,
 * and what it replaced. No other local memory tool exposes this, and it is the
 * difference between a memory you edit and a memory you distrust.
 */
export function cmdWhy(args) {
  const query = args._.join(' ').trim();
  if (!query) {
    fail('Usage: tradwife why "<fact or fragment>"');
    return 1;
  }
  const config = loadConfig();
  const found = [];
  for (const { store, label } of [
    { store: openIdentity(config), label: 'identity' },
    { store: openProject(process.cwd(), config).store, label: 'this project' },
  ]) {
    for (const f of store.find(query)) found.push({ fact: f, label, store });
  }

  if (!found.length) {
    warn(`Nothing stored matches "${query}".`);
    const past = findEntries((e) => typeof e.text === 'string' && e.text.toLowerCase().includes(query.toLowerCase()), 5);
    if (past.length) {
      say(c.gray('\nBut the journal has history for it:'));
      for (const e of past) bullet(`${e.at.slice(0, 10)} ${c.dim(e.event)} "${e.text}"`, e.reason ? `— ${e.reason}` : '');
    }
    return 1;
  }

  for (const { fact, label, store } of found) {
    heading(fact.text);
    say(`  ${c.gray('store')}       ${label} · section "${fact.section}"`);
    say(`  ${c.gray('source')}      ${describeSource(fact.source)}`);
    say(`  ${c.gray('confidence')}  ${(fact.confidence ?? 0).toFixed(2)}${fact.pinned ? c.magenta('  (pinned)') : ''}`);
    say(`  ${c.gray('seen')}        ${plural(fact.seen || 1, 'time')} across ${plural(fact.sessions?.length || 0, 'session')}`);
    say(`  ${c.gray('first')}       ${(fact.first || '').slice(0, 19).replace('T', ' ')}`);
    say(`  ${c.gray('last')}        ${(fact.last || '').slice(0, 19).replace('T', ' ')}`);
    say(`  ${c.gray('score')}       ${fmtScore(store.score(fact))} ${c.gray('(confidence x recency x repetition x intent)')}`);
    if (fact.evidence) say(`  ${c.gray('you wrote')}   ${c.dim(`"${fact.evidence}"`)}`);
    if (fact.supersedes?.length) {
      const history = findEntries((e) => e.id === fact.id && e.event === 'superseded', 5);
      for (const h of history) say(`  ${c.gray('replaced')}    "${h.replaced?.text}" ${c.gray(`(${h.reason})`)}`);
    }
  }
  return 0;
}

function fmtScore(v) {
  return Number.isFinite(v) ? v.toFixed(3) : 'pinned';
}

function describeSource(source) {
  return {
    manual: 'you typed it into `tradwife remember`',
    explicit: 'you stated it directly in a prompt ("remember that…", "always…")',
    capture: 'it came up in enough separate sessions to be promoted',
    import: 'imported from a file',
  }[source] || source || 'unknown';
}
