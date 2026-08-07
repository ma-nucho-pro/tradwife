#!/usr/bin/env node
/**
 * GitHub auto-connect and auto-sync, end to end.
 *
 * `gh` is faked with a script on PATH so all three user situations can be tested
 * without a network or a real account: signed in, installed but signed out, and
 * not installed at all. The last one matters most — a tool that only works for
 * people who already have everything set up is a tool for nobody new.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'tradwife.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tradwife-gh-'));

let passed = 0, failed = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \u001b[32m✓\u001b[0m ${label}`); }
  else { failed++; failures.push(`${label}${detail ? `\n      ${detail}` : ''}`); console.log(`  \u001b[31m✗\u001b[0m ${label}\n      ${detail}`); }
};
const section = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

/** A bare repo standing in for GitHub, plus a fake `gh` that talks to it. */
const remote = path.join(sandbox, 'github', 'tester', 'tradwife-memory.git');
fs.mkdirSync(path.dirname(remote), { recursive: true });

function fakeGh({ authed = true, repoPresent = false } = {}) {
  const dir = path.join(sandbox, `bin-${authed ? 'auth' : 'anon'}-${repoPresent ? 'has' : 'none'}`);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '#!/usr/bin/env bash',
    'case "$1 $2" in',
    '  "--version ")  echo "gh version 2.60.0"; exit 0 ;;',
    authed
      ? '  "auth status") echo "Logged in to github.com as tester"; exit 0 ;;'
      : '  "auth status") echo "not logged in" >&2; exit 1 ;;',
    authed ? '  "api user")    echo tester; exit 0 ;;' : '  "api user")    exit 1 ;;',
    '  "config get")  echo https; exit 0 ;;',
    // Stateful, like the real thing: the repo exists once it has been created.
    // A fake that always says "not found" made setup fall back to a URL that
    // was never going to resolve, and the failure looked like a product bug.
    repoPresent
      ? `  "repo view")   echo '{"name":"tradwife-memory","url":"${remote}","sshUrl":"${remote}"}'; exit 0 ;;`
      : `  "repo view")   if [ -d "${remote}" ]; then echo '{"name":"tradwife-memory","url":"${remote}","sshUrl":"${remote}"}'; exit 0; else echo "not found" >&2; exit 1; fi ;;`,
    '  "repo list")   echo "[]"; exit 0 ;;',
    `  "repo create") git init --bare -b main "${remote}" >/dev/null 2>&1; echo created; exit 0 ;;`,
    'esac',
    'exit 1',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'gh'), lines.join('\n'), { mode: 0o755 });
  return dir;
}

function machine(name, { ghDir = null } = {}) {
  const home = path.join(sandbox, name, '.tradwife');
  const repo = path.join(sandbox, name, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  // A PATH without gh unless one is supplied, so "not installed" is real.
  const basePath = ['/usr/bin', '/bin', path.dirname(process.execPath)].join(':');
  const env = {
    ...process.env,
    PATH: ghDir ? `${ghDir}:${basePath}` : basePath,
    TRADWIFE_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(sandbox, name, '.claude'),
    TRADWIFE_NO_COLOR: '1', NO_COLOR: '1',
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@t`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@t`,
  };
  const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { env, cwd: repo, input, encoding: 'utf8' });
  const md = () => { try { return fs.readFileSync(path.join(home, 'identity.md'), 'utf8'); } catch { return ''; } };
  const say = (prompt, session = Math.random().toString(36).slice(2, 8)) => {
    run(['capture'], JSON.stringify({ session_id: session, cwd: repo, prompt }));
    run(['harvest', '--quiet'], JSON.stringify({ session_id: session }));
  };
  return { name, home, repo, env, run, md, say };
}

// ---------------------------------------------------------------------------
section('the common case — gh installed and signed in');
const laptop = machine('laptop', { ghDir: fakeGh({ authed: true }) });
laptop.run(['init']);
let r = laptop.run(['init']);
check('init offers the one-command sync when gh is ready',
  /sync setup/.test(r.stdout) && /tester/.test(r.stdout), r.stdout);

laptop.say('recuerda que prefiero respuestas cortas');
r = laptop.run(['sync', 'setup']);
check('sync setup with NO URL exits 0', r.status === 0, (r.stderr || r.stdout).trim());
check('creates the repo by itself', /Creating a private repo|Created/.test(r.stdout), r.stdout);
check('says out loud that it is private', /private/i.test(r.stdout));
const laptopCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(laptop.home, 'config.json'), 'utf8')); } catch { return {}; } })();
check('turns auto-sync on', /auto/i.test(r.stdout) && laptopCfg.autoSync === true, JSON.stringify(laptopCfg));
check('tells you the one command for the next machine', /tradwife clone/.test(r.stdout), r.stdout);
check('sessions/ is git-ignored, so prompts never leave the machine',
  fs.readFileSync(path.join(laptop.home, '.gitignore'), 'utf8').includes('sessions/'));
check('the remote points at the account gh reported',
  spawnSync('git', ['-C', laptop.home, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.includes('tester/tradwife-memory'));

// ---------------------------------------------------------------------------
section('a second machine — clone with no arguments');
const desktop = machine('desktop', { ghDir: fakeGh({ authed: true, repoPresent: true }) });
r = desktop.run(['clone']);
check('clone with NO URL exits 0', r.status === 0, (r.stderr || r.stdout).trim());
check('found the repo on the account without being told', /Found tester\/tradwife-memory/.test(r.stdout), r.stdout);
check('the laptop\'s memory arrived', /respuestas cortas/i.test(desktop.md()), desktop.md());
const desktopCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(desktop.home, 'config.json'), 'utf8')); } catch { return {}; } })();
check('auto-sync is on here too', desktopCfg.autoSync === true, JSON.stringify(desktopCfg));

// ---------------------------------------------------------------------------
section('auto-sync — nobody has to remember to push');
desktop.run(['remember', 'Nunca hago deploy los viernes']);
r = desktop.run(['harvest']);   // the SessionEnd path, which pushes
check('harvest exits 0 with auto-sync on', r.status === 0, r.stderr);

// force the rate limiter open, then pull on the laptop the way SessionStart does
fs.writeFileSync(path.join(laptop.home, '.last-sync'), '0');
r = laptop.run(['inject'], JSON.stringify({ session_id: 'new', cwd: laptop.repo, source: 'startup' }));
check('inject exits 0 while syncing', r.status === 0, r.stderr);
check('THE LAPTOP PICKED UP THE DESKTOP\'S FACT WITH NO MANUAL SYNC',
  /viernes/i.test(laptop.md()), laptop.md());

// ---------------------------------------------------------------------------
section('the rate limiter — no network trip on every session');
const before = fs.readFileSync(path.join(laptop.home, '.last-sync'), 'utf8');
laptop.run(['inject'], JSON.stringify({ session_id: 'again', cwd: laptop.repo, source: 'startup' }));
check('a second session within the window does not sync again',
  fs.readFileSync(path.join(laptop.home, '.last-sync'), 'utf8') === before);

// ---------------------------------------------------------------------------
section('gh installed but signed out');
const signedOut = machine('signedout', { ghDir: fakeGh({ authed: false }) });
signedOut.run(['init']);
r = signedOut.run(['sync', 'setup']);
check('fails cleanly, without a stack trace', r.status === 1 && !/at .*\.js:\d+/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(0, 200));
check('says exactly what is wrong', /not signed in/i.test(r.stdout), r.stdout);
check('gives the command to fix it', /gh auth login/.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
section('no gh at all — the minority that must not be left stuck');
const bare = machine('bare');
bare.run(['init']);
r = bare.run(['init']);
check('init does not advertise sync it cannot deliver', !/sync setup/.test(r.stdout), r.stdout);

r = bare.run(['sync', 'setup']);
check('fails cleanly', r.status === 1 && !/at .*\.js:\d+/.test(r.stdout + r.stderr));
check('explains that gh is missing', /GitHub CLI/i.test(r.stdout), r.stdout);
check('gives install commands for macOS, Ubuntu and Windows',
  /brew install gh/.test(r.stdout) && /apt install gh/.test(r.stdout) && /winget/.test(r.stdout), r.stdout);
check('AND offers the route that needs no gh at all',
  /PRIVATE repo/i.test(r.stdout) && /sync setup <its-url>/.test(r.stdout), r.stdout);

r = bare.run(['clone']);
check('clone with no url and no gh fails cleanly', r.status === 1 && !/at .*\.js:\d+/.test(r.stdout + r.stderr));
check('and points at passing the url directly', /tradwife clone <url>/.test(r.stdout), r.stdout);

// the manual path must actually work without gh
const manualRemote = path.join(sandbox, 'manual.git');
spawnSync('git', ['init', '--bare', '-b', 'main', manualRemote], { encoding: 'utf8' });
bare.say('recuerda que trabajo de noche');
r = bare.run(['sync', 'setup', manualRemote]);
check('THE MANUAL ROUTE WORKS WITH NO gh INSTALLED', r.status === 0, (r.stderr || r.stdout).trim());
const bare2 = machine('bare2');
r = bare2.run(['clone', manualRemote]);
check('and another gh-less machine can clone it', r.status === 0 && /noche/i.test(bare2.md()), bare2.md());

// ---------------------------------------------------------------------------
section('offline and hostile conditions');
const offline = machine('offline', { ghDir: fakeGh({ authed: true }) });
offline.run(['init']);
offline.run(['sync', 'setup', '/nonexistent/nowhere.git']);
offline.say('recuerda que uso pnpm');
r = offline.run(['inject'], JSON.stringify({ session_id: 'x', cwd: offline.repo, source: 'startup' }));
check('a dead remote never blocks a session from starting', r.status === 0, r.stderr.slice(0, 150));
check('and the memory still works locally', /pnpm/i.test(offline.md()), offline.md());
r = offline.run(['harvest']);
check('a dead remote never breaks harvest', r.status === 0, r.stderr.slice(0, 150));

// auto-sync off means genuinely off
const manual = machine('manual', { ghDir: fakeGh({ authed: true }) });
manual.run(['init']);
manual.run(['config', 'autoSync', 'false']);
manual.say('recuerda que reviso PRs por la mañana');
check('with auto-sync off, no sync stamp is written',
  !fs.existsSync(path.join(manual.home, '.last-sync')));

// ---------------------------------------------------------------------------
section('privacy — what must never reach the repo');
laptop.run(['capture'], JSON.stringify({ session_id: 'sec', cwd: laptop.repo, prompt: 'recuerda que mi token es ghp_abcdefghijklmnopqrstuvwxyz1234' }));
laptop.run(['harvest', '--quiet'], JSON.stringify({ session_id: 'sec' }));
fs.writeFileSync(path.join(laptop.home, '.last-sync'), '0');
laptop.run(['sync']);
const tracked = spawnSync('git', ['-C', laptop.home, 'ls-files'], { encoding: 'utf8' }).stdout;
check('no session buffer is tracked by git', !/sessions\//.test(tracked), tracked);
const blob = spawnSync('git', ['-C', laptop.home, 'grep', '-I', 'ghp_abcdefghijklmnopqrstuvwxyz1234', 'HEAD'], { encoding: 'utf8' });
check('THE CREDENTIAL IS NOWHERE IN GIT HISTORY', blob.status !== 0, blob.stdout.slice(0, 200));

// ---------------------------------------------------------------------------
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) { console.log(`\u001b[32m${passed} checks passed, 0 failed.\u001b[0m`); process.exit(0); }
console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed:\n`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(1);
