import { compileContext } from '../core/compile.js';
import { harvestSession, harvestPending } from '../core/harvest.js';
import { appendPrompt, listSessions } from '../core/session.js';
import { loadConfig } from '../core/config.js';
import { readStdin, say, ok, info, c, bullet, heading } from '../util/out.js';
import { safeId } from '../util/paths.js';

/**
 * Everything in this file runs inside an agent hook. Two rules follow from that:
 *
 *   - never exit non-zero. A crashing hook shows the user an error on every
 *     prompt and, worse, teaches them to uninstall. tradwife failing is always
 *     better than tradwife being noisy.
 *   - never write anything unexpected to stdout. On SessionStart and
 *     UserPromptSubmit, stdout is fed straight into the model's context.
 */

/**
 * Read and normalise the hook payload.
 *
 * The three agents disagree on field names for the same things. Cursor sends
 * `conversation_id` and `text`; Claude Code and Codex send `session_id` and
 * `prompt`. Normalising here means every command downstream sees one shape,
 * and a rename in one agent is a one-line fix rather than a hunt.
 */
async function hookInput() {
  const raw = await readStdin();
  if (!raw.trim()) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  return {
    ...data,
    session_id: data.session_id || data.conversation_id || data.sessionId || null,
    prompt: data.prompt ?? data.text ?? null,
    cwd: data.cwd || (Array.isArray(data.workspace_roots) ? data.workspace_roots[0] : null) || process.cwd(),
  };
}

/**
 * `tradwife inject` — SessionStart.
 * Flushes any session buffer left behind by a previous run, then prints the
 * memory block. The flush is what makes a crashed or force-quit session safe.
 */
export async function cmdInject(args) {
  const config = loadConfig();
  const input = await hookInput();
  const cwd = input.cwd || process.cwd();
  const current = input.session_id ? safeId(input.session_id) : null;

  if (config.capture !== false) {
    try {
      harvestPending({ config, exclude: current });
    } catch {
      /* a harvest failure must never block a session from starting */
    }
  }

  // Pull anything the other machines learned. Rate-limited and fail-silent:
  // a laptop with no signal must still open a session instantly.
  try {
    const { autoSync } = await import('./gitsync.js');
    autoSync({ pull: true, config });
  } catch {
    /* sync is best effort, never a precondition for working */
  }

  const { text, tokens, empty } = compileContext({ cwd, config });

  if (args.json) {
    say(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: empty ? '' : text,
      },
    }));
    return 0;
  }

  if (empty) return 0;
  process.stdout.write(text);
  if (args.verbose) process.stderr.write(`tradwife: injected ${tokens} tokens\n`);
  return 0;
}

/**
 * `tradwife capture` — UserPromptSubmit.
 * Appends the prompt to this session's buffer and stays silent. No extraction
 * happens here: the hook must return fast, and a fact is only interesting once
 * the session it came from is over.
 */
export async function cmdCapture(args) {
  const config = loadConfig();
  if (config.capture === false) return 0;
  const input = await hookInput();
  const prompt = input.prompt ?? args._[0] ?? '';
  if (!String(prompt).trim()) return 0;

  try {
    appendPrompt(input.session_id || 'manual', {
      prompt,
      cwd: input.cwd || process.cwd(),
      agent: args.agent || input.hook_event_name || 'unknown',
    });
  } catch {
    /* buffering is best effort */
  }
  return 0;
}

/**
 * `tradwife harvest` — SessionEnd, or run by hand.
 * With --stdin it harvests the session the hook reports. With no arguments it
 * harvests every buffered session.
 */
export async function cmdHarvest(args) {
  const config = loadConfig();
  let sessionId = args.session || null;
  let cwd = process.cwd();

  if (args.stdin || (!sessionId && !process.stdin.isTTY)) {
    const input = await hookInput();
    if (input.session_id) sessionId = safeId(input.session_id);
    if (input.cwd) cwd = input.cwd;
  }

  const reports = sessionId
    ? [harvestSession(sessionId, { config })]
    : listSessions().map((id) => harvestSession(id, { config }));

  // Cursor has no session-start hook that can inject context, so its rules file
  // is rewritten here instead, at the end of the session that changed memory.
  if (args.refreshCursor) {
    try {
      const { writeRules } = await import('../agents/cursor.js');
      writeRules(cwd);
    } catch {
      /* refreshing the rules file must never fail a session */
    }
  }

  // Push what this session learned, so the next machine starts current.
  try {
    const { autoSync } = await import('./gitsync.js');
    autoSync({ pull: false, config });
  } catch {
    /* best effort */
  }

  if (args.quiet || args.stdin) return 0;

  if (!reports.length || reports.every((r) => r.prompts === 0)) {
    info('Nothing to harvest. No buffered sessions.');
    return 0;
  }

  for (const r of reports) {
    heading(`Session ${c.dim(r.sessionId)} · ${r.prompts} prompt(s)`);
    const show = (label, list, colorFn) => {
      if (!list.length) return;
      say(`  ${colorFn(label)}`);
      for (const item of list.slice(0, 12)) {
        bullet(item.text, item.previous ? `(replaced: "${item.previous}")` : `[${item.store}]`);
      }
      if (list.length > 12) say(c.gray(`    …and ${list.length - 12} more`));
    };
    show('remembered', r.added, c.green);
    show('confirmed again', r.reinforced, c.cyan);
    show('updated', r.superseded, c.yellow);
    if (r.staged.length) {
      say(`  ${c.gray('waiting for a second sighting')}`);
      for (const s of r.staged.slice(0, 8)) bullet(c.gray(s.text), `${s.sessions}/${s.needed}`);
    }
    if (r.pruned.length) say(`  ${c.gray(`pruned ${r.pruned.length} low-value fact(s) to stay in budget`)}`);
    if (args.verbose && r.rejected.length) {
      say(`  ${c.gray('rejected')}`);
      for (const rej of r.rejected.slice(0, 10)) bullet(c.gray(rej.text), `— ${rej.reason}`);
    }
    if (!r.added.length && !r.reinforced.length && !r.superseded.length && !r.staged.length) {
      say(c.gray('  nothing worth keeping'));
    }
  }
  if (!args.verbose) {
    const rejected = reports.reduce((n, r) => n + r.rejected.length, 0);
    if (rejected) say(c.gray(`\n${rejected} candidate(s) rejected. Run with --verbose to see why.`));
  }
  return 0;
}
