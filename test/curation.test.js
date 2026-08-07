import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let sandbox, home, repo;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tradwife-curation-'));
  home = path.join(sandbox, '.tradwife');
  repo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  process.env.TRADWIFE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, '.claude');
  process.env.CODEX_HOME = path.join(sandbox, '.codex');
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.TRADWIFE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

const { openIdentity, openProject } = await import('../src/core/memory.js');
const { loadConfig } = await import('../src/core/config.js');
const { compileContext } = await import('../src/core/compile.js');
const { DORMANT } = await import('../src/core/store.js');
const { parseInstructions, stripManaged, importFrom, sources } = await import('../src/core/import.js');
const { sight, spread } = await import('../src/core/crossproject.js');
const { BEGIN, END } = await import('../src/agents/codex.js');

const DAY = 86_400_000;
const age = (store, text, days) => {
  const [f] = store.find(text);
  store.index.facts[f.id].last = new Date(Date.now() - days * DAY).toISOString();
  return f.id;
};

describe('dormancy — the fix for silent staleness', () => {
  test('a fact you stopped mentioning goes dormant', () => {
    const store = openIdentity();
    store.upsert({ text: 'Uses Redis for caching', section: 'Who', source: 'capture' });
    age(store, 'Redis', 200);
    const moved = store.goDormant(120);
    assert.equal(moved.length, 1);
    assert.equal(store.activeFacts().length, 0);
    assert.equal(store.dormantFacts().length, 1, 'it must stay in the file, not vanish');
  });

  test('a dormant fact is NOT injected but IS still on disk', () => {
    const store = openIdentity();
    store.upsert({ text: 'Uses Redis for caching', section: 'Who', source: 'capture' });
    store.upsert({ text: 'Prefers short answers', section: 'Preferences', source: 'capture' });
    age(store, 'Redis', 200);
    store.goDormant(120);
    store.save();

    const { text } = compileContext({ cwd: repo });
    assert.ok(!/Redis/.test(text), 'a dormant fact leaked into the injected context');
    assert.ok(/short answers/.test(text), 'the live fact must survive');
    assert.ok(fs.readFileSync(path.join(home, 'identity.md'), 'utf8').includes('Redis'),
      'it must remain visible in the file so the user can see what was set aside');
  });

  test('a recent fact is untouched', () => {
    const store = openIdentity();
    store.upsert({ text: 'Prefers short answers', section: 'Preferences', source: 'capture' });
    assert.equal(store.goDormant(120).length, 0);
  });

  test('a pinned fact never goes dormant, however long the silence', () => {
    const store = openIdentity();
    store.upsert({ text: 'Speaks Spanish as a first language', section: 'Who', source: 'capture' });
    const id = age(store, 'Spanish', 5000);
    store.setPinned(id, true);
    assert.equal(store.goDormant(120).length, 0, 'pinning must be absolute');
  });

  test('a deliberately stated fact gets twice the window', () => {
    const store = openIdentity();
    store.upsert({ text: 'Never deploys on Fridays', section: 'Who', source: 'manual' });
    age(store, 'Fridays', 150);
    assert.equal(store.goDormant(120).length, 0, '150 days is inside the doubled window');
    age(store, 'Fridays', 300);
    assert.equal(store.goDormant(120).length, 1, '300 days is past even the doubled window');
  });

  test('saying it again revives it, back to its original section', () => {
    const store = openIdentity();
    store.upsert({ text: 'Uses Redis for caching', section: 'Preferences', source: 'capture' });
    age(store, 'Redis', 200);
    store.goDormant(120);
    assert.equal(store.get(store.find('Redis')[0].id).section, DORMANT);

    const result = store.upsert({ text: 'Uses Redis for caching', section: 'Preferences', source: 'capture' });
    assert.equal(result.action, 'revived');
    const fact = store.get(result.id);
    assert.equal(fact.dormant, false);
    assert.equal(fact.section, 'Preferences', 'it must go home, not sit in whatever section revived it');
    assert.equal(store.activeFacts().length, 1);
  });

  test('dormant facts cost zero tokens', () => {
    const store = openIdentity();
    for (const t of ['Uses Redis for caching', 'Uses Kafka for events', 'Uses Nginx as proxy']) {
      store.upsert({ text: t, section: 'Who', source: 'capture' });
    }
    const before = store.tokens();
    age(store, 'Redis', 200);
    age(store, 'Kafka', 200);
    store.goDormant(120);
    assert.ok(store.tokens() < before, `tokens did not drop: ${before} -> ${store.tokens()}`);
  });

  test('moving a line into ## Dormant by hand works, and back out', () => {
    const store = openIdentity();
    store.upsert({ text: 'Uses Redis for caching', section: 'Preferences', source: 'capture' });
    store.save();

    fs.writeFileSync(path.join(home, 'identity.md'),
      '# t\n\n## Dormant\n- Uses Redis for caching\n');
    let reloaded = openIdentity();
    assert.equal(reloaded.activeFacts().length, 0, 'a hand-made move into Dormant must be respected');
    assert.equal(reloaded.dormantFacts().length, 1);

    fs.writeFileSync(path.join(home, 'identity.md'),
      '# t\n\n## Preferences\n- Uses Redis for caching\n');
    reloaded = openIdentity();
    assert.equal(reloaded.activeFacts().length, 1, 'and a move back out must revive it');
  });

  test('the rendered Dormant section explains itself', () => {
    const store = openIdentity();
    store.upsert({ text: 'Uses Redis for caching', section: 'Who', source: 'capture' });
    age(store, 'Redis', 200);
    store.goDormant(120);
    const md = store.render();
    assert.match(md, /## Dormant/);
    assert.match(md, /no longer sent to the agent/i);
    assert.match(md, /Say one again/i, 'the user must be told how to undo it');
    assert.ok(md.indexOf('## Dormant') > md.indexOf('## Who'), 'Dormant belongs at the bottom');
  });
});

describe('import — from the files people already keep', () => {
  test('reads bullets under headings', () => {
    const { kept } = parseInstructions([
      '# My rules', '', '## Style', '- Always use pnpm, never npm',
      '- Prefer functional components', '', '## Testing', '- Write tests with Vitest',
    ].join('\n'));
    assert.equal(kept.length, 3);
    assert.ok(kept.some((k) => /pnpm/.test(k.text)));
  });

  test('reads bare rule-like lines too', () => {
    const { kept } = parseInstructions('# Rules\n\nAlways run the linter before committing.\n');
    assert.equal(kept.length, 1);
  });

  test('ignores code fences entirely', () => {
    const { kept } = parseInstructions([
      '# Setup', '```bash', 'npm install', 'always run this first', '```', '', '## Style', '- Use tabs',
    ].join('\n'));
    assert.equal(kept.length, 1);
    assert.match(kept[0].text, /tabs/i);
  });

  test('skips boilerplate headings', () => {
    const { kept } = parseInstructions('## Installation\n- npm install foo\n- npm run build\n');
    assert.equal(kept.length, 0, 'install steps are not facts about the user');
  });

  test('a credential in a CLAUDE.md is dropped, not imported', () => {
    const { kept, skipped } = parseInstructions('## Env\n- Always use token ghp_abcdefghijklmnopqrstuvwxyz1234\n');
    assert.equal(kept.length, 0);
    assert.ok(skipped.some((s) => /credential/i.test(s.reason)));
  });

  test('markdown emphasis and links are stripped from the stored fact', () => {
    const { kept } = parseInstructions('## Style\n- **Always** use `pnpm`, see [docs](https://x.com)\n');
    assert.ok(!/[*`]/.test(kept[0].text), `emphasis survived: ${kept[0].text}`);
    assert.ok(!/https/.test(kept[0].text));
  });

  test("Tradwife never re-imports its own managed block", () => {
    const doc = `# Mine\n\n## Style\n- Use tabs\n\n${BEGIN}\n\n## About the person\n- Prefers short answers\n\n${END}\n`;
    assert.ok(!stripManaged(doc).includes('Prefers short answers'), 'feedback loop: Tradwife would re-learn its own output');
    const { kept } = parseInstructions(doc);
    assert.equal(kept.length, 1);
    assert.match(kept[0].text, /tabs/i);
  });

  test('file scope decides fact scope', () => {
    fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, '.claude', 'CLAUDE.md'), '## Me\n- Always answer in Spanish\n');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '## Repo\n- Never commit directly to main\n');

    const config = loadConfig();
    const identity = openIdentity(config);
    const project = openProject(repo, config);
    const { imported } = importFrom({ identity, project: project.store, config, cwd: repo });

    assert.ok(imported.length >= 2, `expected both files imported, got ${imported.length}`);
    assert.ok(identity.facts().some((f) => /Spanish/i.test(f.text)), 'user file must land in identity');
    assert.ok(project.store.facts().some((f) => /main/i.test(f.text)), 'project file must land in project');
    assert.ok(!identity.facts().some((f) => /main/i.test(f.text)),
      "a repo convention must not follow the user into every other project");
  });

  test('dry run changes nothing on disk', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '## Repo\n- Never commit directly to main\n');
    const config = loadConfig();
    const identity = openIdentity(config);
    const project = openProject(repo, config);
    const { imported } = importFrom({ identity, project: project.store, config, cwd: repo, dryRun: true });
    assert.ok(imported.length >= 1);
    assert.equal(openProject(repo, config).store.facts().length, 0, 'dry run wrote to disk');
  });

  test('importing twice does not duplicate', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '## Repo\n- Never commit directly to main\n- Use pnpm not npm\n');
    const config = loadConfig();
    const run = () => importFrom({ identity: openIdentity(config), project: openProject(repo, config).store, config, cwd: repo });
    run();
    const after = openProject(repo, config).store.facts().length;
    run();
    assert.equal(openProject(repo, config).store.facts().length, after, 'second import duplicated facts');
  });

  test('sources() only lists files that exist', () => {
    assert.equal(sources(repo).length, 0);
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '- Use pnpm\n');
    assert.equal(sources(repo).length, 1);
  });
});

describe('cross-project promotion', () => {
  test('one repo is not enough, three is', () => {
    const t = 'Never commits directly to main';
    assert.equal(sight({ text: t, projectKey: 'repo-a', threshold: 3 }), false);
    assert.equal(sight({ text: t, projectKey: 'repo-b', threshold: 3 }), false);
    assert.equal(sight({ text: t, projectKey: 'repo-c', threshold: 3 }), true);
  });

  test('the same repo repeating itself proves nothing', () => {
    const t = 'Runs the linter before pushing';
    for (let i = 0; i < 8; i++) {
      assert.equal(sight({ text: t, projectKey: 'repo-a', threshold: 3 }), false,
        'one repo must never reach the threshold on its own');
    }
  });

  test('it only fires once, not on every later sighting', () => {
    const t = 'Writes tests before refactors';
    sight({ text: t, projectKey: 'a', threshold: 2 });
    assert.equal(sight({ text: t, projectKey: 'b', threshold: 2 }), true);
    assert.equal(sight({ text: t, projectKey: 'c', threshold: 2 }), false, 'promoted twice');
  });

  test('spread() reports how widespread a fact is', () => {
    sight({ text: 'Uses pnpm', projectKey: 'a', threshold: 3 });
    sight({ text: 'Uses pnpm', projectKey: 'b', threshold: 3 });
    sight({ text: 'Only here', projectKey: 'a', threshold: 3 });
    const wide = spread(2);
    assert.equal(wide.length, 1);
    assert.equal(wide[0].projects.length, 2);
  });

  test('wording differences do not split the same fact', () => {
    sight({ text: 'Never commits directly to main.', projectKey: 'a', threshold: 3 });
    sight({ text: 'never commits directly to main', projectKey: 'b', threshold: 3 });
    assert.equal(spread(2).length, 1, 'punctuation and case must not fragment the ledger');
  });
});

describe('regression: the emphasis-stripping credential leak', () => {
  const leaky = [
    '- Always use token ghp_abcdefghijklmnopqrstuvwxyz1234',
    '- **API key**: `sk-ant-abcdefghijklmnopqrstuvwx`',
    '- Set `DATABASE_URL` to postgres://user:pw@db.example.com:5432/app',
    '- AWS key is AKIAIOSFODNN7EXAMPLE',
    '- api_key = hunter2000supersecret',
  ];
  for (const line of leaky) {
    test(`never imports: ${line.slice(0, 40)}…`, () => {
      const { kept } = parseInstructions(`## Env\n${line}\n`);
      assert.equal(kept.length, 0, `imported: ${JSON.stringify(kept)}`);
    });
  }

  test('the underscore in a token survives long enough to be detected', () => {
    // The original bug: cleanup ran first and ate the underscore, so the
    // github-token pattern could no longer match.
    const { kept, skipped } = parseInstructions('## Env\n- Use ghp_abcdefghijklmnopqrstuvwxyz1234 for CI\n');
    assert.equal(kept.length, 0);
    assert.match(skipped[0].reason, /credential/i);
  });

  test('but a normal underscore in prose is preserved in the stored fact', () => {
    const { kept } = parseInstructions('## Style\n- Always name test files with a _test suffix\n');
    assert.equal(kept.length, 1);
    assert.match(kept[0].text, /_test/, 'underscores in ordinary text must survive cleanup');
  });
});

describe('regression: imperative mood in instruction files', () => {
  const rules = [
    'Write tests with Vitest',
    'Use pnpm, never npm',
    'Run the linter before committing',
    'Build with esbuild, not webpack',
  ];
  for (const rule of rules) {
    test(`imports as a rule: "${rule}"`, () => {
      const { kept } = parseInstructions(`## Style\n- ${rule}\n`);
      assert.equal(kept.length, 1, `an instruction file rule was rejected as a task: ${rule}`);
    });
  }

  test('but a live prompt with the same shape is still rejected', async () => {
    const { extract } = await import('../src/core/extract.js');
    assert.equal(extract('write tests with Vitest for the login module').candidates.length, 0,
      'the task filter must stay on for live prompts');
  });
});
