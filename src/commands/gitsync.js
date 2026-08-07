import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, homeRelative } from '../util/paths.js';
import { readJSON, writeJSON, readText, writeAtomic, exists, readLines, removeFile } from '../util/fsx.js';
import { contradicts, refines } from '../util/text.js';
import { mergeIndex, mergeLedger, mergeJournal } from '../core/merge.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { openIdentity, openProject, listProjects } from '../core/memory.js';
import { Store } from '../core/store.js';
import { say, ok, warn, fail, info, c, heading, blank, plural, bullet } from '../util/out.js';
import { inspect, repoUrl, lookupRepo, createRepo, findMemoryRepo, manualSteps } from '../core/github.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', '..', 'bin', 'tradwife.js');

function git(args, { cwd = paths.home(), quiet = true } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!quiet && res.stderr) process.stderr.write(res.stderr);
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

const isRepo = () => git(['rev-parse', '--git-dir']).code === 0;

/**
 * Register a custom merge driver.
 *
 * Without this, git resolves a conflict in identity.index.json by picking a
 * side, and one machine's week of learning disappears. With it, git hands both
 * versions plus their common ancestor to `tradwife merge-driver`, which merges them
 * by meaning and writes the result back.
 *
 * The driver is registered in .git/config rather than committed, because it
 * points at this machine's node binary and this checkout.
 */
function installDriver() {
  const home = paths.home();
  git(['config', 'merge.tradwife.name', 'Tradwife semantic memory merge']);
  git(['config', 'merge.tradwife.driver', `"${process.execPath}" "${BIN}" merge-driver %O %A %B`]);

  // Markdown is rebuilt from the merged index, so its merge only has to not
  // fail. `merge=ours` looks like it would do that but is NOT a git built-in —
  // without this definition every sync stopped on a markdown conflict and never
  // reached the semantic merge at all. `driver = true` succeeds and leaves %A
  // untouched, which is exactly the no-op wanted here.
  git(['config', 'merge.tradtradwife-md.name', 'Keep local markdown; it is regenerated after the merge']);
  git(['config', 'merge.tradtradwife-md.driver', 'true']);

  const attrs = path.join(home, '.gitattributes');
  const wanted = [
    '# Memory is merged by meaning, not by line. See `tradwife merge-driver`.',
    '*.index.json    merge=tradwife',
    'cross-project.json merge=tradwife',
    'journal.jsonl   merge=tradwife',
    '# Markdown is regenerated from the merged index, so either side will do.',
    '*.md            merge=tradtradwife-md',
    '',
  ].join('\n');
  if (!exists(attrs) || !readText(attrs, '').includes('merge=tradtradwife-md')) writeAtomic(attrs, wanted);

  // Machine-local scratch that must never travel. `.last-sync` in particular:
  // it is a timestamp, so it differs on every machine, and versioning it made
  // every single sync stop on a conflict in a file nothing needed.
  const ignore = path.join(home, '.gitignore');
  const wantedIgnore = ['sessions/', '.last-sync', '*.corrupt.*', '.DS_Store', ''].join('\n');
  if (!exists(ignore) || !readText(ignore, '').includes('.last-sync')) writeAtomic(ignore, wantedIgnore);
}

/**
 * After any merge, rebuild every markdown file from its merged index.
 *
 * The markdown must be DELETED first, and that detail is load-bearing.
 * `.gitattributes` marks .md as `merge=ours`, so after a merge the file still
 * holds this machine's pre-merge list, while the index holds the merged truth.
 * Store.load treats markdown as authoritative — which is right everywhere
 * else — so simply opening the store here re-adopted every fact the other
 * machine had deliberately deleted. Removing the file first makes the index
 * authoritative for exactly this one rebuild, which is the behaviour
 * Store already has for a missing file.
 */
function regenerateMarkdown(config = loadConfig()) {
  let n = 0;
  removeFile(paths.identity());
  const identity = openIdentity(config);
  reconcile(identity);
  identity.save({ force: true });
  n++;
  for (const meta of listProjects()) {
    removeFile(paths.projectMd(meta.key));
    const store = new Store({
      mdPath: paths.projectMd(meta.key),
      indexPath: paths.projectIndex(meta.key),
      sections: config.projectSections,
      title: `Tradwife · ${meta.name}`,
      header: null,
      halfLife: config.halfLife.project,
      scope: `project:${meta.key}`,
    }).load();
    reconcile(store);
    store.save({ force: true });
    n++;
  }
  return n;
}

/**
 * Resolve contradictions that only became visible once two machines were merged.
 *
 * The per-fact merge unions facts by id, so a statement and its negation arrive
 * as two separate entries and would otherwise sit side by side. These are the
 * same rules `Store.upsert` applies locally; the newer statement wins, because
 * across machines "more recent" is the only ordering that means anything.
 */
function reconcile(store) {
  const facts = store.facts();
  const dropped = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i];
      const b = facts[j];
      if (dropped.includes(a.id) || dropped.includes(b.id)) continue;
      const clash = contradicts(a.text, b.text);
      const refinement = refines(a.text, b.text);
      if (!clash && refinement === 0) continue;
      let loser;
      if (clash) loser = Date.parse(a.last || 0) >= Date.parse(b.last || 0) ? b : a;
      else loser = refinement === 1 ? a : b;   // the less specific one loses
      if (loser.pinned) continue;
      store.remove(loser.id, clash ? 'contradicted by a newer statement on another machine' : 'restated more precisely on another machine');
      dropped.push(loser.id);
    }
  }
  return dropped.length;
}

/**
 * `tradwife merge-driver <base> <ours> <theirs>` — invoked by git, not by you.
 *
 * Must exit 0 on success and leave the merged result in the `ours` path.
 * Exiting non-zero tells git the conflict is unresolved, which is worse than
 * any imperfect merge, so failures fall back to keeping the local copy.
 */
export function cmdMergeDriver(args) {
  const [basePath, oursPath, theirsPath] = args._;
  if (!oursPath || !theirsPath) {
    process.stderr.write('tradwife merge-driver: called without file paths\n');
    return 1;
  }

  try {
    if (oursPath.endsWith('journal.jsonl')) {
      const merged = mergeJournal(readLines(oursPath), readLines(theirsPath));
      writeAtomic(oursPath, merged.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return 0;
    }
    if (oursPath.endsWith('cross-project.json')) {
      writeJSON(oursPath, mergeLedger(readJSON(basePath, null), readJSON(oursPath, null), readJSON(theirsPath, null)));
      return 0;
    }
    const { index } = mergeIndex(readJSON(basePath, null), readJSON(oursPath, null), readJSON(theirsPath, null));
    writeJSON(oursPath, index);
    return 0;
  } catch (error) {
    process.stderr.write(`tradwife merge-driver: ${error.message} — keeping the local copy\n`);
    return 0; // never leave git with an unresolved conflict
  }
}

/**
 * `tradwife sync` — carry your memory between machines.
 *
 * First run wires ~/.tradwife up as a git repo with the semantic merge driver.
 * Every run after that is commit, pull, merge, push.
 */
export function cmdSync(args) {
  const home = paths.home();
  const config = loadConfig();

  if (args._[0] === 'setup' || args.remote) {
    let remote = args.remote || args._[1];

    /**
     * With no URL, try to do the whole thing. Most people running a coding
     * agent already have git working and gh signed in, and for them there is
     * nothing to decide: the repo is private, it is named after the tool, and
     * it lives on their own account.
     */
    if (!remote) {
      const state = inspect();
      if (state.canAuto) {
        let found = lookupRepo(state.user, 'tradwife-memory', state.protocol);
        if (!found) {
          info(`Creating a private repo on your GitHub account (${state.user})…`);
          const made = createRepo();
          if (!made.ok) {
            fail(`GitHub said: ${made.error}`);
            say(c.gray('  You can still pass a repo yourself: tradwife sync setup <url>'));
            return 1;
          }
          ok(`Created ${state.user}/tradwife-memory ${c.gray('(private)')}`);
          found = lookupRepo(state.user, 'tradwife-memory', state.protocol);
        } else {
          ok(`Found your existing ${state.user}/tradwife-memory`);
        }
        remote = found?.url || repoUrl(state.user, 'tradwife-memory', state.protocol);
      } else {
        heading('Cannot set this up automatically yet');
        say(c.gray(`  ${state.reason}.\n`));
        const guide = manualSteps(state);
        say(`  ${c.bold(guide.headline)}`);
        for (const step of guide.steps) say(step ? `    ${step}` : '');
        return 1;
      }
    }
    if (!isRepo()) {
      const init = git(['init', '-b', 'main']);
      if (init.code !== 0) { fail(`git init failed: ${init.err}`); return 1; }
    }
    installDriver();
    git(['remote', 'remove', 'origin']);
    const add = git(['remote', 'add', 'origin', remote]);
    if (add.code !== 0) { fail(`could not add the remote: ${add.err}`); return 1; }

    // Push straight away, so "set up" means set up rather than half done.
    const pushed = pushNow(branchOf());
    ok(`${homeRelative(home)} is synced`);
    say(c.gray(`  remote      ${remote}`));
    say(c.gray('  private     yes — this holds a profile built from what you type'));
    say(c.gray('  merge       facts are merged by meaning, not by line'));
    say(c.gray('  ignored     sessions/ never leaves this machine'));
    if (!pushed) warn('  Could not push yet. Run `tradwife sync` once you are online.');

    // Opt out with --no-auto. Checking `config.autoSync !== false` was wrong:
    // the default IS false, so the branch never ran and setup silently left
    // auto-sync off — the exact opposite of what setting it up should mean.
    if (args.auto !== false) {
      const cfg = loadConfig();
      cfg.autoSync = true;
      saveConfig(cfg);
      say(c.gray('  auto        on — every session syncs by itself'));
    }
    blank();
    say(c.bold('On your other machines, one command:'));
    say('  tradwife clone');
    say(c.gray('  It finds this repo on your account by itself.'));
    return 0;
  }

  if (!isRepo()) {
    info('Not set up for sync yet.');
    say(c.gray('  tradwife sync setup <git-remote-url>   (use a private repo)'));
    return 0;
  }
  installDriver(); // repair the driver after a fresh clone or a moved checkout

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']).out;
  if (staged) {
    git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'commit', '-m', `memory: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
  }

  const hasRemote = git(['remote', 'get-url', 'origin']).code === 0;
  if (!hasRemote) {
    warn('No remote configured. Run: tradwife sync setup <url>');
    return 1;
  }

  const fetch = git(['fetch', 'origin', branch]);
  const remoteExists = fetch.code === 0 && git(['rev-parse', `origin/${branch}`]).code === 0;

  let merged = false;
  if (remoteExists) {
    const before = git(['rev-parse', 'HEAD']).out;
    const pull = git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'merge', `origin/${branch}`, '--no-edit', '-m', 'memory: merge']);
    if (pull.code !== 0) {
      fail('The merge did not complete cleanly.');
      say(c.gray(`  ${pull.err.split('\n')[0]}`));
      say(c.gray(`  Your memory is untouched. Inspect it with: git -C ${homeRelative(home)} status`));
      return 1;
    }
    merged = git(['rev-parse', 'HEAD']).out !== before;
    if (merged) {
      const files = regenerateMarkdown(config);
      git(['add', '-A']);
      if (git(['diff', '--cached', '--name-only']).out) {
        git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'commit', '-m', 'memory: rebuild markdown from merged index']);
      }
      ok(`Merged the other machine in · ${plural(files, 'file')} rebuilt`);
    }
  }

  const push = git(['push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    fail(`Push failed: ${push.err.split('\n')[0]}`);
    return 1;
  }

  const identity = openIdentity(config);
  if (!staged && !merged) info('Already up to date.');
  else ok('Synced.');
  say(c.gray(`  ${plural(identity.activeFacts().length, 'fact')} in identity · ${plural(listProjects().length, 'project')} tracked`));
  return 0;
}

/** `tradwife clone <remote>` — set a new machine up from an existing memory repo. */
export function cmdClone(args) {
  let remote = args._[0];

  // No URL: go and find the memory repo on this account.
  if (!remote) {
    const found = findMemoryRepo();
    if (found) {
      info(`Found ${found.user}/${found.name} on your GitHub account`);
      remote = found.url;
    } else {
      const state = inspect();
      if (!state.canAuto) {
        heading('Cannot find your memory repo automatically');
        say(c.gray(`  ${state.reason}.\n`));
        const guide = manualSteps(state);
        say(`  ${c.bold(guide.headline)}`);
        for (const step of guide.steps) say(step ? `    ${step}` : '');
        say(c.gray('\n  Or pass it directly: tradwife clone <url>'));
        return 1;
      }
      fail('No memory repo found on your account.');
      say(c.gray('  Run `tradwife sync setup` on the machine that already has your memory first.'));
      return 1;
    }
  }
  const home = paths.home();
  if (exists(path.join(home, 'identity.md'))) {
    fail(`${homeRelative(home)} already has memory in it.`);
    say(c.gray('  Move it aside first, or use `tradwife sync setup <url>` to merge this machine into the repo.'));
    return 1;
  }
  const res = spawnSync('git', ['clone', remote, home], { encoding: 'utf8' });
  if (res.status !== 0) {
    fail(`Clone failed: ${(res.stderr || '').split('\n')[0]}`);
    return 1;
  }
  installDriver();
  const config = loadConfig();
  config.autoSync = true;
  saveConfig(config);
  const identity = openIdentity(config);
  ok(`Memory restored to ${homeRelative(home)}`);
  say(c.gray(`  ${plural(identity.activeFacts().length, 'fact')} in identity · ${plural(listProjects().length, 'project')} tracked`));
  say(c.gray('  auto-sync is on: this machine stays in step with the others by itself'));
  blank();
  say(c.bold('Next:'));
  say('  tradwife attach claude   ' + c.gray('# or codex, cursor, gemini'));
  return 0;
}

const branchOf = () => git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';

function pushNow(branch) {
  git(['add', '-A']);
  if (git(['diff', '--cached', '--name-only']).out) {
    git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'commit', '-m', 'memory: initial']);
  }
  return git(['push', '-u', 'origin', branch]).code === 0;
}

/**
 * Sync in the background, called from the session hooks.
 *
 * Runs only when auto-sync is on, and only if enough time has passed since the
 * last attempt, because a network round trip on every session start is a tax
 * nobody agreed to. Everything here fails silently: a laptop on a plane must
 * still open a session instantly.
 */
export function autoSync({ pull = false, config = loadConfig() } = {}) {
  if (config.autoSync !== true) return false;
  if (!isRepo()) return false;

  const stampFile = path.join(paths.home(), '.last-sync');
  const last = Number(readText(stampFile, '0')) || 0;
  const minGap = (config.autoSyncMinutes ?? 5) * 60_000;
  if (Date.now() - last < minGap) return false;

  try {
    const branch = branchOf();
    git(['add', '-A']);
    if (git(['diff', '--cached', '--name-only']).out) {
      git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'commit', '-m', `memory: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
    }
    if (pull) {
      const fetched = git(['fetch', 'origin', branch]);
      if (fetched.code === 0 && git(['rev-parse', `origin/${branch}`]).code === 0) {
        const before = git(['rev-parse', 'HEAD']).out;
        const merged = git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'merge', `origin/${branch}`, '--no-edit']);
        if (merged.code === 0 && git(['rev-parse', 'HEAD']).out !== before) {
          regenerateMarkdown(config);
          git(['add', '-A']);
          if (git(['diff', '--cached', '--name-only']).out) {
            git(['-c', 'user.email=tradwife@localhost', '-c', 'user.name=tradwife', 'commit', '-m', 'memory: rebuild after merge']);
          }
        } else if (merged.code !== 0) {
          git(['merge', '--abort']);   // never leave the repo mid-merge
          return false;
        }
      }
    }
    git(['push', 'origin', branch]);
    writeAtomic(stampFile, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** `tradwife sync status` — where this machine stands relative to the others. */
export function cmdSyncStatus() {
  if (!isRepo()) {
    info('Sync is not set up.');
    say(c.gray('  tradwife sync setup <git-remote-url>'));
    return 0;
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  const remote = git(['remote', 'get-url', 'origin']).out || '(none)';
  const dirty = git(['status', '--porcelain']).out;
  git(['fetch', 'origin', branch]);
  const counts = git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]).out || '0\t0';
  const [ahead, behind] = counts.split(/\s+/).map(Number);

  heading('Sync');
  say(`  remote     ${remote}`);
  say(`  branch     ${branch}`);
  say(`  local      ${dirty ? c.yellow(`${dirty.split('\n').length} uncommitted change(s)`) : c.green('clean')}`);
  say(`  ahead      ${ahead || 0} commit(s) this machine has and the others do not`);
  say(`  behind     ${behind || 0} commit(s) another machine has and this one does not`);
  if (ahead || behind || dirty) say(c.gray('\n  Run `tradwife sync` to reconcile.'));
  return 0;
}
