import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let sandbox;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tradwife-agents-'));
  process.env.TRADWIFE_HOME = path.join(sandbox, '.tradwife');
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, '.claude');
  process.env.CODEX_HOME = path.join(sandbox, '.codex');
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.TRADWIFE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

const { attachClaude, detachClaude, claudeStatus, isTradwifeHandler, tradwifeHooks } = await import('../src/agents/claude.js');
const { attachCodex, detachCodex, codexStatus, upsertBlock, codexHooks, hooksPath,
  isTradwifeHandler: isTradwifeCodexHandler, BEGIN, END } = await import('../src/agents/codex.js');
const { refines, contradicts } = await import('../src/util/text.js');
const { openIdentity } = await import('../src/core/memory.js');

describe('regression: merging must not collapse different facts', () => {
  test('one differing word keeps two facts apart, however long they are', () => {
    const a = 'Deploys to production every Friday afternoon after the tests pass';
    const b = 'Deploys to staging every Friday afternoon after the tests pass';
    assert.equal(refines(a, b), 0, 'these say different things and must both survive');
    assert.equal(contradicts(a, b), false);
  });

  test('a strictly more detailed restatement does merge', () => {
    assert.equal(refines('Prefers short answers', 'Prefers short direct answers'), 1);
    assert.equal(refines('Prefers short direct answers', 'Prefers short answers'), -1);
  });

  test('different technologies never merge', () => {
    assert.equal(refines('Uses Postgres for storage', 'Uses MySQL for storage'), 0);
    assert.equal(refines('Writes Kotlin', 'Writes Swift'), 0);
  });

  test('the store keeps both variants', () => {
    const store = openIdentity();
    store.upsert({ text: 'Deploys to production every Friday after tests pass', section: 'Who' });
    store.upsert({ text: 'Deploys to staging every Friday after tests pass', section: 'Who' });
    assert.equal(store.facts().length, 2);
  });
});

describe('Claude Code wiring', () => {
  test('registers the three lifecycle hooks', () => {
    const res = attachClaude();
    const settings = JSON.parse(fs.readFileSync(res.file, 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
  });

  test('SessionEnd declares a timeout above the 1.5s shared budget', () => {
    const hooks = tradwifeHooks('/usr/bin/node');
    const sessionEnd = hooks.SessionEnd[0].hooks[0];
    assert.ok(sessionEnd.timeout >= 5, 'harvest needs more than the default SessionEnd budget');
  });

  test('uses exec form with an absolute path, so PATH and spaces cannot break it', () => {
    const hooks = tradwifeHooks('/usr/bin/node');
    const handler = hooks.SessionStart[0].hooks[0];
    assert.equal(handler.command, '/usr/bin/node');
    assert.ok(path.isAbsolute(handler.args[0]));
    assert.match(handler.args[0], /tradwife\.js$/);
  });

  test('leaves existing settings completely untouched', () => {
    const file = path.join(sandbox, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }, null, 2));

    attachClaude();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.permissions.allow, ['Bash(git *)']);
    assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'prettier --write');
    const starts = after.hooks.SessionStart.flatMap((g) => g.hooks);
    assert.ok(starts.some((h) => h.command === 'echo hi'), 'the user\'s own SessionStart hook was destroyed');
    assert.ok(starts.some(isTradwifeHandler), 'tradwife did not register');
  });

  test('attaching twice does not duplicate', () => {
    attachClaude();
    attachClaude();
    attachClaude();
    const settings = JSON.parse(fs.readFileSync(claudeStatus().file, 'utf8'));
    const wifeHandlers = Object.values(settings.hooks).flat().flatMap((g) => g.hooks).filter(isTradwifeHandler);
    assert.equal(wifeHandlers.length, 3, `expected 3 handlers, found ${wifeHandlers.length}`);
  });

  test('detach removes only tradwife and leaves the rest intact', () => {
    const file = path.join(sandbox, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }));
    attachClaude();
    const res = detachClaude();
    assert.equal(res.removed, 3);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'echo hi');
    assert.equal(claudeStatus().attached, false);
  });

  test('detach on a machine with no settings file does not throw', () => {
    assert.doesNotThrow(() => detachClaude());
  });

  test('status reports honestly before and after', () => {
    assert.equal(claudeStatus().attached, false);
    attachClaude();
    assert.equal(claudeStatus().attached, true);
  });
});

describe('Codex wiring', () => {
  test('registers real lifecycle hooks, not just a text block', () => {
    const res = attachCodex();
    const hooks = JSON.parse(fs.readFileSync(res.file, 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'].sort());
    assert.equal(codexStatus().attached, true);
    assert.deepEqual(codexStatus().events.sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'].sort());
  });

  test('the session ends on Stop, not SessionEnd', () => {
    const hooks = codexHooks('/usr/bin/node');
    assert.ok(hooks.Stop, 'Codex has no SessionEnd event; wiring one there would never fire');
    assert.equal(Object.hasOwn(hooks, 'SessionEnd'), false);
  });

  test('SessionStart only fires on startup and resume, not on clear', () => {
    assert.match(codexHooks('/usr/bin/node').SessionStart[0].matcher, /startup/);
  });

  test('still writes the AGENTS.md fallback for builds without hooks', () => {
    const res = attachCodex();
    const content = fs.readFileSync(res.fallback, 'utf8');
    assert.ok(content.includes(BEGIN));
    assert.ok(content.includes(END));
  });

  test('enables the codex_hooks feature flag for older builds', () => {
    attachCodex();
    const cfg = fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf8');
    assert.match(cfg, /codex_hooks\s*=\s*true/);
  });

  test('attaching twice does not duplicate handlers', () => {
    attachCodex();
    attachCodex();
    attachCodex();
    const hooks = JSON.parse(fs.readFileSync(hooksPath(), 'utf8')).hooks;
    const mine = Object.values(hooks).flat().flatMap((g) => g.hooks || []).filter(isTradwifeCodexHandler);
    assert.equal(mine.length, 3, `expected 3 handlers, found ${mine.length}`);
  });

  test('leaves another tool\'s Codex hooks alone', () => {
    const file = hooksPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }));
    attachCodex();
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
    const all = hooks.SessionStart.flatMap((g) => g.hooks);
    assert.ok(all.some((h) => h.command === 'echo hi'), 'destroyed another tool\'s hook');
    assert.ok(all.some(isTradwifeCodexHandler));
  });

  test('never touches text outside its markers', () => {
    const before = '# My rules\n\nAlways run `bun test` before pushing.\n';
    const merged = upsertBlock(before, `${BEGIN}\nBLOCK\n${END}`);
    assert.ok(merged.startsWith('# My rules'));
    assert.ok(merged.includes('Always run `bun test` before pushing.'));
    assert.ok(merged.includes('BLOCK'));
  });

  test('re-syncing replaces the block in place instead of stacking copies', () => {
    const withBlock = upsertBlock('# Mine\n', `${BEGIN}\nOLD\n${END}`);
    const resynced = upsertBlock(withBlock, `${BEGIN}\nNEW\n${END}`);
    assert.equal((resynced.match(new RegExp(BEGIN.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
    assert.ok(resynced.includes('NEW'));
    assert.ok(!resynced.includes('OLD'));
    assert.ok(resynced.includes('# Mine'));
  });

  test('detach removes hooks and the block, leaving other content behind', () => {
    const file = path.join(sandbox, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# House rules\n\nUse tabs.\n');
    attachCodex();
    detachCodex();
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('# House rules'));
    assert.ok(after.includes('Use tabs.'));
    assert.ok(!after.includes(BEGIN));
  });
});
