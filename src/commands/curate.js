import readline from 'node:readline';
import { loadConfig } from '../core/config.js';
import { openIdentity, openProject } from '../core/memory.js';
import { importFrom, sources } from '../core/import.js';
import { spread, promote } from '../core/crossproject.js';
import { DORMANT } from '../core/store.js';
import { homeRelative } from '../util/paths.js';
import { say, ok, warn, info, c, heading, bullet, blank, plural } from '../util/out.js';

/**
 * `tradwife import` — seed memory from the instruction files you already keep.
 *
 * The most common reaction to Tradwife is "I already have a CLAUDE.md". That is
 * usually true, and it is work worth keeping rather than arguing with.
 */
export function cmdImport(args) {
  const config = loadConfig();
  const found = sources(process.cwd());

  if (!found.length) {
    info('No CLAUDE.md or AGENTS.md found to import from.');
    say(c.gray('  Looked in ~/.claude, ~/.codex, and this project root.'));
    return 0;
  }

  const identity = openIdentity(config);
  const project = openProject(process.cwd(), config);
  const dryRun = Boolean(args.dryRun || args.n);
  const { imported, skipped, files } = importFrom({
    identity, project: project.store, config, cwd: process.cwd(), dryRun,
  });

  heading(dryRun ? 'Would import' : 'Imported');
  for (const f of files) {
    say(`  ${c.bold(f.label.padEnd(30))} ${plural(f.found, 'candidate')}${f.rejected ? c.gray(` · ${f.rejected} skipped`) : ''}`);
  }

  if (!imported.length) {
    blank();
    info(dryRun ? 'Nothing new to import.' : 'Nothing new — everything there was already known.');
    return 0;
  }

  for (const scope of ['user', 'project']) {
    const items = imported.filter((i) => i.scope === scope);
    if (!items.length) continue;
    heading(scope === 'user' ? 'To identity' : `To project "${project.name}"`);
    for (const i of items.slice(0, 25)) bullet(i.text, c.gray(i.from));
    if (items.length > 25) say(c.gray(`    …and ${items.length - 25} more`));
  }

  blank();
  if (dryRun) {
    info('Dry run. Run `tradwife import` to apply.');
  } else {
    ok(`${plural(imported.length, 'fact')} imported.`);
    say(c.gray('  Review with `tradwife show`, drop anything wrong with `tradwife forget "..."`,'));
    say(c.gray('  or just edit the markdown file — hand edits always win.'));
  }
  if (skipped.length && args.verbose) {
    heading('Skipped');
    for (const s of skipped.slice(0, 20)) bullet(c.gray(s.text), `— ${s.reason}`);
  } else if (skipped.length) {
    // Name credentials explicitly. "1 line skipped" next to a file that held an
    // API key reads as vague; the user should be told that specific thing was
    // caught, because it is the reassurance that matters most here.
    const secrets = skipped.filter((s) => /credential/i.test(s.reason)).length;
    const rest = skipped.length - secrets;
    const parts = [];
    if (secrets) parts.push(c.green(`${plural(secrets, 'line')} with credentials dropped`));
    if (rest) parts.push(c.gray(`${plural(rest, 'other line')} skipped`));
    say(`\n${parts.join(c.gray(' · '))}${c.gray(' — --verbose for detail')}`);
  }
  return 0;
}

/**
 * `tradwife review` — decide what stays.
 *
 * "What I struggle with isn't writing the context, it's deciding what deserves
 * to stay" is the most common real complaint about memory files. The promotion
 * gate and the token ceiling automate most of that decision; this is where you
 * make the calls the rules cannot.
 */
export async function cmdReview(args) {
  const config = loadConfig();
  const identity = openIdentity(config);
  const project = openProject(process.cwd(), config);

  const queue = [];
  for (const { store, label } of [
    { store: identity, label: 'identity' },
    { store: project.store, label: project.name },
  ]) {
    for (const p of store.pending()) {
      queue.push({ kind: 'pending', store, label, id: p.id, text: p.text, section: p.section, meta: `seen in ${plural(p.sessions?.length || 0, 'session')}` });
    }
    for (const d of store.dormantFacts()) {
      const days = Math.round((Date.now() - Date.parse(d.last || d.first || 0)) / 86400000);
      queue.push({ kind: 'dormant', store, label, id: d.id, text: d.text, section: d.homeSection, meta: `quiet for ${days} days` });
    }
  }

  const crossProject = spread(2).filter((e) => !e.promoted);
  if (!queue.length && !crossProject.length) {
    ok('Nothing to review.');
    say(c.gray('  No candidates waiting and nothing has gone dormant.'));
    return 0;
  }

  if (!process.stdin.isTTY || args.list) {
    heading('Waiting for a second sighting');
    const pending = queue.filter((q) => q.kind === 'pending');
    if (!pending.length) say(c.gray('  none'));
    for (const q of pending) bullet(q.text, `[${q.label}] ${q.meta}`);

    heading('Dormant');
    const dormant = queue.filter((q) => q.kind === 'dormant');
    if (!dormant.length) say(c.gray('  none'));
    for (const q of dormant) bullet(c.gray(q.text), `[${q.label}] ${q.meta}`);

    if (crossProject.length) {
      heading('Showing up in more than one repo');
      for (const e of crossProject) bullet(e.text, `${plural(e.projects.length, 'repo')}`);
      say(c.gray(`\n  At ${config.crossProjectThreshold} repos these move to identity automatically.`));
    }
    if (!process.stdin.isTTY) say(c.gray('\nRun `tradwife review` in a terminal to act on these.'));
    return 0;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim().toLowerCase())));

  heading(`Review · ${plural(queue.length, 'item')}`);
  say(c.gray('  [k] keep   [d] drop   [p] pin   [s] skip   [q] quit\n'));

  let kept = 0, dropped = 0, pinned = 0;
  for (const item of queue) {
    const tag = item.kind === 'pending' ? c.yellow('waiting') : c.gray('dormant');
    say(`${tag} ${c.bold(item.text)}`);
    say(c.gray(`  ${item.label} · ${item.meta}`));
    const answer = await ask('  > ');

    if (answer === 'q') break;
    if (answer === 'd') {
      if (item.kind === 'pending') { delete item.store.index.pending[item.id]; item.store.dirty = true; }
      else item.store.remove(item.id, 'dropped during review');
      dropped++;
    } else if (answer === 'k' || answer === 'p') {
      if (item.kind === 'pending') {
        const p = item.store.index.pending[item.id];
        delete item.store.index.pending[item.id];
        item.store.dirty = true;
        item.store.upsert({ text: p.text, section: p.section, kind: p.kind, source: 'manual', confidence: 1, evidence: 'confirmed during review' });
      } else {
        const fact = item.store.index.facts[item.id];
        fact.dormant = false;
        fact.section = item.section || item.store.configuredSections[0];
        fact.last = new Date().toISOString();
        delete fact.homeSection;
        item.store.dirty = true;
      }
      kept++;
      if (answer === 'p') {
        const [f] = item.store.find(item.text);
        if (f) { item.store.setPinned(f.id, true); pinned++; }
      }
    }
    blank();
  }
  rl.close();

  for (const store of [identity, project.store]) {
    store.prune(store.scope === 'user' ? config.budget.identity : config.budget.project);
    store.save();
  }
  ok(`${kept} kept, ${dropped} dropped${pinned ? `, ${pinned} pinned` : ''}.`);
  return 0;
}

/** `tradwife spread` — which facts follow you across repos. */
export function cmdSpread() {
  const config = loadConfig();
  const entries = spread(2);
  if (!entries.length) {
    info('Nothing has shown up in more than one repo yet.');
    say(c.gray('  Tradwife tracks this automatically as you work across projects.'));
    return 0;
  }
  heading('Facts appearing in more than one repo');
  for (const e of entries) {
    const status = e.promoted ? c.green('· in identity') : c.gray(`· ${config.crossProjectThreshold - e.projects.length} more to promote`);
    bullet(e.text, `${plural(e.projects.length, 'repo')} ${status}`);
  }
  say(c.gray(`\n  Say the same thing in ${config.crossProjectThreshold} repos and it stops being about any one of them.`));
  return 0;
}
