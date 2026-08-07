import { spawnSync } from 'node:child_process';

/**
 * GitHub auto-connect.
 *
 * The assumption behind this module: most people running a coding agent already
 * have git working and many have the GitHub CLI authenticated. For them, "sync
 * my memory across machines" should be one command with no arguments — no repo
 * to create by hand, no URL to paste, no token to generate.
 *
 * The assumption is not universal, so every path degrades to something the user
 * can act on. Detection never throws, never prompts, and never assumes a
 * network. When it cannot do the thing itself it says exactly what to run.
 */

const DEFAULT_REPO = 'tradwife-memory';

function run(cmd, args, { timeout = 15000, input } = {}) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout, input });
    return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), code: res.status };
  } catch {
    return { ok: false, out: '', err: 'command not available', code: -1 };
  }
}

const has = (cmd) => run(cmd, ['--version'], { timeout: 5000 }).ok;

/**
 * What can this machine actually do right now?
 * @returns {{git, gh, ghAuth, user, protocol, canAuto, reason}}
 */
export function inspect() {
  const git = has('git');
  const gh = has('gh');
  let ghAuth = false;
  let user = null;
  let protocol = 'https';

  if (gh) {
    // `gh auth status` exits non-zero when logged out; that is the check.
    ghAuth = run('gh', ['auth', 'status'], { timeout: 10000 }).ok;
    if (ghAuth) {
      const who = run('gh', ['api', 'user', '--jq', '.login'], { timeout: 10000 });
      if (who.ok && who.out) user = who.out;
      const proto = run('gh', ['config', 'get', 'git_protocol'], { timeout: 5000 });
      if (proto.ok && proto.out) protocol = proto.out;
    }
  }

  const canAuto = git && gh && ghAuth && Boolean(user);
  const reason = !git ? 'git is not installed'
    : !gh ? 'the GitHub CLI (gh) is not installed'
      : !ghAuth ? 'the GitHub CLI is installed but not signed in'
        : !user ? 'could not read your GitHub username'
          : null;

  return { git, gh, ghAuth, user, protocol, canAuto, reason };
}

export function repoUrl(user, name = DEFAULT_REPO, protocol = 'https') {
  return protocol === 'ssh' ? `git@github.com:${user}/${name}.git` : `https://github.com/${user}/${name}.git`;
}

/**
 * Look the repo up and return the clone URL GitHub itself reports.
 *
 * Building the URL by hand from a username was wrong: gh already knows the
 * exact clone URL, including enterprise hosts and whatever protocol the user
 * configured. Asking is both shorter and correct in cases guessing is not.
 *
 * @returns {{name, url}|null}
 */
export function lookupRepo(user, name = DEFAULT_REPO, protocol = 'https') {
  if (!user) return null;
  const res = run('gh', ['repo', 'view', `${user}/${name}`, '--json', 'name,url,sshUrl'], { timeout: 15000 });
  if (!res.ok) return null;
  try {
    const data = JSON.parse(res.out);
    // Append .git only when it is not already there. gh returns the web URL
    // without it today, but an enterprise host or a future version may not, and
    // "repo.git.git" fails with a message that points nowhere useful.
    const withSuffix = (u) => (!u || /\.git$/.test(u) ? u : `${u}.git`);
    const url = protocol === 'ssh' ? (data.sshUrl || withSuffix(data.url)) : withSuffix(data.url || data.sshUrl);
    return { name: data.name || name, url: url || repoUrl(user, name, protocol) };
  } catch {
    // Older gh, or a stubbed one, may not return JSON. The repo exists either way.
    return { name, url: res.out.trim().startsWith('/') ? res.out.trim() : repoUrl(user, name, protocol) };
  }
}

export function repoExists(user, name = DEFAULT_REPO) {
  return lookupRepo(user, name) !== null;
}

/**
 * Create the private repo. Private is not configurable here on purpose: this
 * holds a profile built from everything the user types into their agent, and a
 * public default would be a mistake nobody notices until it is too late.
 */
export function createRepo(name = DEFAULT_REPO) {
  const res = run('gh', ['repo', 'create', name, '--private',
    '--description', 'My agent memory, synced by tradwife. Private.'], { timeout: 40000 });
  if (res.ok) return { ok: true, created: true };
  if (/already exists|Name already exists/i.test(res.err)) return { ok: true, created: false };
  return { ok: false, error: res.err.split('\n')[0] || 'gh repo create failed' };
}

/**
 * Find an existing memory repo on this account, for setting up machine two.
 * Falls back to any private repo whose name looks like a tradwife memory store,
 * so a user who named theirs something else is still found.
 */
export function findMemoryRepo() {
  const state = inspect();
  if (!state.canAuto) return null;
  const direct = lookupRepo(state.user, DEFAULT_REPO, state.protocol);
  if (direct) return { user: state.user, name: direct.name, url: direct.url };

  const list = run('gh', ['repo', 'list', state.user, '--limit', '100', '--json', 'name,isPrivate'], { timeout: 20000 });
  if (!list.ok) return null;
  try {
    const match = JSON.parse(list.out).find((r) => r.isPrivate && /tradwife|agent-?memory/i.test(r.name));
    if (match) {
      const found = lookupRepo(state.user, match.name, state.protocol);
      return { user: state.user, name: match.name, url: found?.url || repoUrl(state.user, match.name, state.protocol) };
    }
  } catch {
    /* unparseable list: treat as not found */
  }
  return null;
}

/**
 * Instructions for the machines this cannot set up on its own.
 * Ordered easiest first, and each step is a command they can paste.
 */
export function manualSteps(state = inspect()) {
  if (!state.git) {
    return {
      headline: 'git is not installed',
      steps: [
        'macOS:    xcode-select --install',
        'Ubuntu:   sudo apt install git',
        'Windows:  https://git-scm.com/download/win',
        'Then run: tradwife sync setup',
      ],
    };
  }
  if (!state.gh) {
    return {
      headline: 'The GitHub CLI would make this automatic',
      steps: [
        'macOS:    brew install gh',
        'Ubuntu:   sudo apt install gh',
        'Windows:  winget install GitHub.cli',
        'Then:     gh auth login   →   tradwife sync setup',
        '',
        'Or skip it entirely: create a PRIVATE repo on github.com yourself and run',
        '  tradwife sync setup <its-url>',
      ],
    };
  }
  if (!state.ghAuth) {
    return {
      headline: 'The GitHub CLI is installed but not signed in',
      steps: ['gh auth login', 'tradwife sync setup'],
    };
  }
  return { headline: 'Ready', steps: ['tradwife sync setup'] };
}
