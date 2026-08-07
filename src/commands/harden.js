import readline from 'node:readline';
import { loadConfig } from '../core/config.js';
import { openIdentity, openProject } from '../core/memory.js';
import { proposals, loadGuards, activeGuards, addGuard, removeGuard, saveGuards, evaluate } from '../core/guards.js';
import { attachClaude, claudeStatus } from '../agents/claude.js';
import { readStdin, say, ok, warn, fail, info, c, heading, bullet, blank, plural } from '../util/out.js';
import { factId } from '../util/text.js';

/**
 * `tradwife guard` — the PreToolUse hook runner.
 *
 * Reads the tool call on stdin and answers allow or deny. Two hard rules:
 * it must always exit 0 (a non-zero exit from a PreToolUse hook is an error
 * on every single tool call), and any failure must allow the call through.
 * A guard that wrongly blocks is worse than a guard that wrongly allows,
 * because the user cannot work around the first one.
 */
export async function cmdGuard(args = {}) {
  let input = {};
  try {
    const raw = await readStdin(2000);
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    return 0; // unparseable payload: allow
  }

  // Cursor names things differently and puts the command at the top level.
  const normalised = {
    ...input,
    cwd: input.cwd || (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null) || process.cwd(),
    tool_name: input.tool_name || (input.command !== undefined ? 'Bash' : input.tool_name),
    tool_input: input.tool_input || (input.command !== undefined ? { command: input.command } : {}),
  };

  let verdict = { deny: false };
  try {
    verdict = evaluate(normalised);
  } catch {
    return 0; // fail open, always
  }

  const style = args.style || 'claude';
  const message = verdict.deny ? `${verdict.reason} [blocked by tradwife: "${verdict.guard.from}"]` : '';

  if (!verdict.deny) {
    // Cursor expects an explicit allow; the others treat silence as allow.
    if (style === 'cursor') say(JSON.stringify({ continue: true, permission: 'allow' }));
    return 0;
  }

  if (style === 'codex') {
    // Codex blocks on exit code 2, with the reason on stderr.
    process.stderr.write(`${message}\n`);
    return 2;
  }
  if (style === 'cursor') {
    say(JSON.stringify({ continue: false, permission: 'deny', userMessage: message, agentMessage: message }));
    return 0;
  }
  say(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  }));
  return 0;
}

/**
 * `tradwife harden` — offer to enforce the rules that can be enforced.
 *
 * Deliberately opt-in, one rule at a time. Generating a blocking hook from a
 * sentence the user never meant as a hard rule would be a much worse failure
 * than leaving it as context.
 */
export async function cmdHarden(args) {
  const config = loadConfig();
  const identity = openIdentity(config);
  const project = openProject(process.cwd(), config);
  const facts = [...identity.activeFacts(), ...project.store.activeFacts()];

  const existing = new Set(loadGuards().guards.map((g) => g.id));
  const found = proposals(facts).filter((p) => !existing.has(p.guard.id));

  if (!found.length) {
    const active = activeGuards();
    if (active.length) {
      ok(`Nothing new to harden. ${plural(active.length, 'guard')} already enforced.`);
      say(c.gray('  See them with `tradwife guards`.'));
    } else {
      info('No rules found that a hook could enforce.');
      say(c.gray('  Most of what tradwife remembers — tone, language, preferences —'));
      say(c.gray('  maps to no tool call, so it stays as context by design.'));
    }
    return 0;
  }

  heading(`${plural(found.length, 'rule')} could be enforced instead of suggested`);
  say(c.gray('  Right now these are injected as text: the agent almost always follows them.'));
  say(c.gray('  As a guard they are checked on every tool call, identically, always.\n'));

  if (!process.stdin.isTTY || args.list) {
    for (const p of found) {
      bullet(p.fact.text, c.gray(`→ blocks ${p.detector.label}`));
    }
    say(c.gray('\n  Run `tradwife harden` in a terminal to turn these on.'));
    return 0;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim().toLowerCase())));
  let added = 0;

  for (const p of found) {
    say(`${c.bold(p.fact.text)}`);
    say(c.gray(`  would block  ${p.detector.label}`));
    say(c.gray(`  matches      ${p.guard.pattern}`));
    if (p.guard.branches) say(c.gray(`  on branches  ${p.guard.branches.join(', ')}`));
    const answer = await ask(`  ${c.cyan('enforce this? [y/N/q]')} `);
    if (answer === 'q') break;
    if (answer === 'y' || answer === 's') {
      addGuard(p.guard);
      added++;
      ok('  enforced');
    }
    blank();
  }
  rl.close();

  if (!added) {
    info('Nothing changed. These stay as context, which is still how they work today.');
    return 0;
  }

  // A guard is useless until the PreToolUse hook exists to call it.
  if (!claudeStatus().events.includes('PreToolUse')) {
    attachClaude();
    ok('Registered the PreToolUse hook in Claude Code');
  }
  ok(`${plural(added, 'guard')} now enforced.`);
  say(c.gray('  Restart your agent for the hook to load.'));
  say(c.gray('  The rules stay in memory too: the guard stops the action, the memory stops the attempt.'));
  return 0;
}

/**
 * Turn a plain command fragment into a pattern.
 *
 * Asking someone for a regex to protect themselves is a bad trade, so this
 * takes what they would actually type — "terraform apply" — and makes it
 * tolerant of the ways it shows up in a real command line.
 */
function patternFor(literal) {
  const escaped = String(literal).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `\\b${escaped.replace(/\s+/g, '\\s+')}`;
}

/** `tradwife guards` — what is actually being enforced, and `--off <text>` to stop. */
export function cmdGuards(args) {
  const state = loadGuards();

  /**
   * `--add` exists because the built-in detectors only recognise a handful of
   * shapes — git, package managers, rm, .env. Those cover the rules people
   * repeat most, and they cover nobody's whole list. Without a way to enforce
   * an arbitrary rule, "which rules can be guarded" would be a decision baked
   * into this repo rather than one the user makes about their own work.
   */
  if (args.add) {
    const rule = typeof args.add === 'string' ? args.add : args._[0];
    const blocks = typeof args.blocks === 'string' ? args.blocks : null;
    if (!rule || !blocks) {
      fail('Usage: tradwife guards --add "<your rule>" --blocks "<command fragment>"');
      say(c.gray('  e.g.  tradwife guards --add "Nunca terraform apply en prod" --blocks "terraform apply"'));
      say(c.gray('        tradwife guards --add "No toques la config" --blocks "config/prod" --tool Edit'));
      say(c.gray('        tradwife guards --add "No commits en release" --blocks "git commit" --on-branch release'));
      return 1;
    }
    const tool = args.tool || (args.onBranch ? 'Bash' : 'Bash');
    const guard = {
      id: factId(`custom:${blocks}:${args.onBranch || ''}:${tool}`),
      from: rule,
      detector: 'custom',
      label: `\`${blocks}\``,
      kind: args.onBranch ? 'branch' : (['Edit', 'Write', 'Read', 'NotebookEdit'].includes(tool) ? 'path' : 'command'),
      tools: String(tool).split(',').map((t) => t.trim()),
      pattern: patternFor(blocks),
      reason: `Blocked by your own rule: "${rule}"`,
      enabled: true,
    };
    if (args.onBranch) guard.branches = String(args.onBranch).toLowerCase().split(',').map((b) => b.trim());

    if (!addGuard(guard)) { warn('That guard already exists.'); return 1; }
    ok(`Enforcing: "${rule}"`);
    say(c.gray(`  blocks   ${guard.pattern}`));
    if (guard.branches) say(c.gray(`  only on  ${guard.branches.join(', ')}`));
    if (!claudeStatus().events.includes('PreToolUse')) {
      attachClaude();
      ok('Registered the PreToolUse hook in Claude Code');
    }
    say(c.gray('  Restart your agent for it to take effect. Check it with `tradwife guards --test "<command>"`.'));
    return 0;
  }

  /** Dry-run a command against the guards, so you can see what would happen. */
  if (args.test) {
    const command = typeof args.test === 'string' ? args.test : args._[0];
    if (!command) { fail('Usage: tradwife guards --test "<command>"'); return 1; }
    const asPath = /[\\/]/.test(command) && !/\s/.test(command);
    const verdict = evaluate({
      tool_name: asPath ? 'Edit' : 'Bash',
      tool_input: asPath ? { file_path: command } : { command },
      cwd: process.cwd(),
    });
    if (verdict.deny) {
      say(`${c.red('blocked')}  ${command}`);
      say(c.gray(`  your rule: "${verdict.guard.from}"`));
    } else {
      say(`${c.green('allowed')}  ${command}`);
      if (!activeGuards().length) say(c.gray('  (no guards are enforced yet)'));
    }
    return 0;
  }

  if (args.off) {
    const target = typeof args.off === 'string' ? args.off : args._[0];
    if (!target) { fail('Usage: tradwife guards --off "<rule or id>"'); return 1; }
    if (removeGuard(target)) { ok(`Stopped enforcing: "${target}"`); say(c.gray('  It stays in memory as context.')); return 0; }
    warn(`No guard matches "${target}".`);
    return 1;
  }

  if (args.disable || args.enable) {
    const target = args.disable || args.enable;
    const g = state.guards.find((x) => x.id === target || x.from?.toLowerCase().includes(String(target).toLowerCase()));
    if (!g) { warn(`No guard matches "${target}".`); return 1; }
    g.enabled = Boolean(args.enable);
    saveGuards(state);
    ok(`${g.enabled ? 'Enabled' : 'Paused'}: "${g.from}"`);
    return 0;
  }

  if (!state.guards.length) {
    info('No guards enforced.');
    say(c.gray('  Run `tradwife harden` to see which of your rules could be.'));
    return 0;
  }

  heading(`Enforced ${c.gray(`(${plural(state.guards.length, 'guard')})`)}`);
  for (const g of state.guards) {
    const tag = g.enabled === false ? c.yellow('paused') : c.green('active');
    say(`  ${tag} ${c.bold(g.from)}`);
    say(c.gray(`         blocks ${g.label} · ${(g.tools || [g.tool]).join(', ')}`));
    if (args.verbose) say(c.gray(`         ${g.pattern}`));
  }
  say(c.gray('\n  These are checked on every tool call, identically, every time.'));
  say(c.gray('  Everything else tradwife knows stays as context: it has no tool call to intercept.'));
  say(c.gray('  Add one the detectors miss: tradwife guards --add "<rule>" --blocks "<command>"'));
  return 0;
}
