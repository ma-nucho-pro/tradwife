#!/usr/bin/env node
/**
 * Every agent, end to end, through the real CLI.
 *
 * Each one is fed the payload shape its own documentation specifies, and the
 * response is checked against the format that agent actually understands.
 * Getting this wrong fails silently in production — a hook wired to an event
 * that does not exist simply never runs — so none of it is assumed here.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'tradwife.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tradwife-agents-e2e-'));
const repo = path.join(sandbox, 'repo');
fs.mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
spawnSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
spawnSync('git', ['-C', repo, 'config', 'user.name', 't']);

const env = {
  ...process.env,
  TRADWIFE_HOME: path.join(sandbox, '.tradwife'),
  CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
  CODEX_HOME: path.join(sandbox, '.codex'),
  CURSOR_HOME: path.join(sandbox, '.cursor-home'),
  GEMINI_HOME: path.join(sandbox, '.gemini'),
  TRADWIFE_NO_COLOR: '1', NO_COLOR: '1',
};
const tradwife = (args, input) =>
  spawnSync(process.execPath, [BIN, ...args], { env, cwd: repo, input, encoding: 'utf8' });

let passed = 0, failed = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \u001b[32m✓\u001b[0m ${label}`); }
  else { failed++; failures.push(`${label}${detail ? `\n      ${detail}` : ''}`); console.log(`  \u001b[31m✗\u001b[0m ${label}\n      ${detail}`); }
};
const section = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

tradwife(['init']);
tradwife(['remember', 'Prefiere respuestas cortas']);
tradwife(['remember', '--project', 'Nunca hagas force push']);

// ---------------------------------------------------------------------------
section('claude code');
let r = tradwife(['attach', 'claude']);
check('attach exits 0', r.status === 0, r.stderr);
let settings = JSON.parse(fs.readFileSync(path.join(sandbox, '.claude', 'settings.json'), 'utf8'));
check('registers SessionStart, UserPromptSubmit, SessionEnd',
  ['SessionStart', 'UserPromptSubmit', 'SessionEnd'].every((e) => settings.hooks[e]), Object.keys(settings.hooks).join());

r = tradwife(['inject'], JSON.stringify({ session_id: 'c1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }));
check('inject returns the memory', r.status === 0 && /respuestas cortas/i.test(r.stdout), r.stdout.slice(0, 120));

r = tradwife(['capture'], JSON.stringify({ session_id: 'c1', cwd: repo, prompt: 'recuerda que uso Kotlin a diario' }));
check('capture is silent and exits 0', r.status === 0 && r.stdout.trim() === '', JSON.stringify(r.stdout));
r = tradwife(['harvest', '--stdin'], JSON.stringify({ session_id: 'c1', hook_event_name: 'SessionEnd' }));
check('harvest exits 0', r.status === 0, r.stderr);
check('LEARNED from a Claude Code session',
  /Kotlin/i.test(fs.readFileSync(path.join(sandbox, '.tradwife', 'identity.md'), 'utf8')));

// ---------------------------------------------------------------------------
section('codex — real hooks, not just a text block');
r = tradwife(['attach', 'codex']);
check('attach exits 0', r.status === 0, r.stderr);

const codexHooksFile = path.join(sandbox, '.codex', 'hooks.json');
check('writes ~/.codex/hooks.json', fs.existsSync(codexHooksFile));
const ch = JSON.parse(fs.readFileSync(codexHooksFile, 'utf8'));
check('uses Stop, not SessionEnd (Codex has no SessionEnd)',
  Boolean(ch.hooks.Stop) && !ch.hooks.SessionEnd, Object.keys(ch.hooks).join());
check('SessionStart matches startup and resume', /startup/.test(ch.hooks.SessionStart[0].matcher || ''));
check('handlers are type "command", the only type Codex supports',
  Object.values(ch.hooks).flat().flatMap((g) => g.hooks).every((h) => h.type === 'command'));
check('enables [features] codex_hooks for pre-v0.124 builds',
  /codex_hooks\s*=\s*true/.test(fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf8')));
check('still writes the AGENTS.md fallback',
  fs.readFileSync(path.join(sandbox, '.codex', 'AGENTS.md'), 'utf8').includes('tradwife:begin'));

// Codex payload shape, per its docs
const codexPayload = (extra) => JSON.stringify({
  session_id: 'x1', transcript_path: null, cwd: repo, hook_event_name: 'SessionStart', model: 'gpt-5.5', ...extra,
});
r = tradwife(['inject', '--agent', 'codex'], codexPayload({ source: 'startup' }));
check('inject writes plain stdout (Codex feeds SessionStart stdout into context)',
  r.status === 0 && /respuestas cortas/i.test(r.stdout) && !r.stdout.trim().startsWith('{'), r.stdout.slice(0, 100));

r = tradwife(['capture', '--agent', 'codex'], codexPayload({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'recuerda que despliego los martes' }));
check('capture accepts the Codex payload', r.status === 0, r.stderr);
r = tradwife(['harvest', '--stdin', '--quiet'], codexPayload({ hook_event_name: 'Stop', turn_id: 't1' }));
check('harvest runs on Stop', r.status === 0, r.stderr);
check('LEARNED from a Codex session',
  /martes/i.test(fs.readFileSync(path.join(sandbox, '.tradwife', 'identity.md'), 'utf8')),
  fs.readFileSync(path.join(sandbox, '.tradwife', 'identity.md'), 'utf8'));

// ---------------------------------------------------------------------------
section('cursor — different field names, different block format');
r = tradwife(['attach', 'cursor']);
check('attach exits 0', r.status === 0, r.stderr);
const cursorHooksFile = path.join(repo, '.cursor', 'hooks.json');
check('writes .cursor/hooks.json', fs.existsSync(cursorHooksFile));
const cu = JSON.parse(fs.readFileSync(cursorHooksFile, 'utf8'));
check('has version 1, as Cursor requires', cu.version === 1);
check('uses Cursor event names, not Claude Code ones',
  Boolean(cu.hooks.beforeSubmitPrompt) && Boolean(cu.hooks.stop) && !cu.hooks.UserPromptSubmit,
  Object.keys(cu.hooks).join());
check('writes an always-applied rules file',
  fs.readFileSync(path.join(repo, '.cursor', 'rules', 'tradwife-memory.mdc'), 'utf8').includes('alwaysApply: true'));

// Cursor sends conversation_id and text, not session_id and prompt
r = tradwife(['capture', '--agent', 'cursor'], JSON.stringify({
  conversation_id: 'cur-1', generation_id: 'g1', hook_event_name: 'beforeSubmitPrompt',
  text: 'recuerda que reviso los PR por la tarde', workspace_roots: [repo],
}));
check('capture understands conversation_id and text', r.status === 0, r.stderr);
r = tradwife(['harvest', '--stdin', '--quiet', '--refresh-cursor'], JSON.stringify({
  conversation_id: 'cur-1', hook_event_name: 'stop', workspace_roots: [repo],
}));
check('harvest runs on stop', r.status === 0, r.stderr);
check('LEARNED from a Cursor session',
  /PR|tarde/i.test(fs.readFileSync(path.join(sandbox, '.tradwife', 'identity.md'), 'utf8')),
  fs.readFileSync(path.join(sandbox, '.tradwife', 'identity.md'), 'utf8'));
check('and the rules file was refreshed with it',
  /PR|tarde/i.test(fs.readFileSync(path.join(repo, '.cursor', 'rules', 'tradwife-memory.mdc'), 'utf8')));

// ---------------------------------------------------------------------------
section('gemini cli — injection only, and it says so');
r = tradwife(['attach', 'gemini']);
check('attach exits 0', r.status === 0, r.stderr);
check('warns that it does not learn', /injection only/i.test(r.stdout), r.stdout);
check('writes GEMINI.md',
  fs.readFileSync(path.join(sandbox, '.gemini', 'GEMINI.md'), 'utf8').includes('respuestas cortas'));
tradwife(['remember', 'Trabaja de noche']);
r = tradwife(['sync-gemini']);
check('sync-gemini refreshes it', r.status === 0 &&
  /Trabaja de noche/i.test(fs.readFileSync(path.join(sandbox, '.gemini', 'GEMINI.md'), 'utf8')), r.stderr);

// ---------------------------------------------------------------------------
section('guards — three agents, three ways to block');
tradwife(['guards', '--add', 'Nunca hagas force push', '--blocks', 'git push --force']);

r = tradwife(['guard'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: repo }));
let parsed = null;
try { parsed = JSON.parse(r.stdout); } catch { /* handled */ }
check('claude: denies via permissionDecision',
  r.status === 0 && parsed?.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 150));

r = tradwife(['guard', '--style', 'codex'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: repo }));
check('codex: denies with EXIT CODE 2 and the reason on stderr',
  r.status === 2 && /force/i.test(r.stderr), `exit ${r.status}, stderr: ${r.stderr.slice(0, 120)}`);

r = tradwife(['guard', '--style', 'codex'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: repo }));
check('codex: allows with exit code 0', r.status === 0, `exit ${r.status}`);

r = tradwife(['guard', '--style', 'cursor'], JSON.stringify({
  conversation_id: 'c', command: 'git push --force', cwd: repo,
  hook_event_name: 'beforeShellExecution', workspace_roots: [repo],
}));
try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
check('cursor: denies with {continue:false, permission:"deny"}',
  r.status === 0 && parsed?.permission === 'deny' && parsed?.continue === false, r.stdout.slice(0, 150));
check('cursor: the block reason reaches both the user and the agent',
  Boolean(parsed?.userMessage) && Boolean(parsed?.agentMessage));

r = tradwife(['guard', '--style', 'cursor'], JSON.stringify({
  conversation_id: 'c', command: 'ls -la', cwd: repo, hook_event_name: 'beforeShellExecution', workspace_roots: [repo],
}));
try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
check('cursor: allows EXPLICITLY (silence is not allow for Cursor)',
  parsed?.permission === 'allow' && parsed?.continue === true, r.stdout.slice(0, 150));

// guards registered → the PreToolUse equivalents appear on re-attach
tradwife(['attach', 'codex']);
tradwife(['attach', 'cursor']);
check('codex gains PreToolUse once a guard exists',
  Boolean(JSON.parse(fs.readFileSync(codexHooksFile, 'utf8')).hooks.PreToolUse));
check('cursor gains beforeShellExecution once a guard exists',
  Boolean(JSON.parse(fs.readFileSync(cursorHooksFile, 'utf8')).hooks.beforeShellExecution));

// ---------------------------------------------------------------------------
section('resilience — no agent may be broken by a bad payload');
for (const [label, style] of [['claude', []], ['codex', ['--style', 'codex']], ['cursor', ['--style', 'cursor']]]) {
  for (const [what, input] of [['no stdin', ''], ['garbage', 'not json {{'], ['empty object', '{}'], ['null fields', '{"command":null,"tool_input":null}']]) {
    const res = tradwife(['guard', ...style], input);
    check(`${label} guard allows on ${what}`, res.status === 0, `exit ${res.status}`);
  }
}
for (const cmd of [['inject'], ['capture'], ['harvest', '--quiet']]) {
  const res = tradwife(cmd, 'garbage {{{');
  check(`${cmd[0]} survives garbage stdin`, res.status === 0, `exit ${res.status}: ${res.stderr.slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
section('status and detach');
r = tradwife(['status']);
check('status names all four agents',
  ['Claude Code', 'Codex', 'Cursor', 'Gemini'].every((a) => r.stdout.includes(a)), r.stdout);

for (const agent of ['claude', 'codex', 'cursor', 'gemini']) {
  r = tradwife(['detach', agent]);
  check(`detach ${agent} exits 0`, r.status === 0, r.stderr);
}
check('no tradwife hooks left in Claude Code',
  !JSON.stringify(JSON.parse(fs.readFileSync(path.join(sandbox, '.claude', 'settings.json'), 'utf8'))).includes('tradwife.js'));
check('no tradwife hooks left in Codex',
  !JSON.stringify(JSON.parse(fs.readFileSync(codexHooksFile, 'utf8'))).includes('tradwife.js'));
check('no tradwife hooks left in Cursor',
  !JSON.stringify(JSON.parse(fs.readFileSync(cursorHooksFile, 'utf8'))).includes('tradwife.js'));
check('the Cursor rules file is gone too',
  !fs.existsSync(path.join(repo, '.cursor', 'rules', 'tradwife-memory.mdc')));
check('memory itself survived every detach',
  fs.readFileSync(path.join(sandbox, '.tradwife', 'identity.md'), 'utf8').includes('respuestas cortas'));

// ---------------------------------------------------------------------------
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) { console.log(`\u001b[32m${passed} checks passed, 0 failed.\u001b[0m`); process.exit(0); }
console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed:\n`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(1);
