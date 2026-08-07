import { loadConfig } from './config.js';
import { openIdentity, openProject } from './memory.js';
import { estimateTokens } from '../util/text.js';

/**
 * Claude Code caps hook output at 10,000 characters. Staying well under it
 * keeps the block intact even if a user raises their budgets.
 */
export const HARD_CHAR_CAP = 9000;

/**
 * Assemble the block that gets injected into the agent.
 *
 * Deliberately written as plain factual statements. Claude Code's own hook
 * documentation warns that text framed as out-of-band system commands trips
 * prompt-injection defences and gets surfaced to the user instead of used as
 * context. "The user prefers short answers" works; "YOU MUST ALWAYS ANSWER
 * SHORT" gets flagged and wastes the injection.
 */
export function compileContext({ cwd = process.cwd(), config = loadConfig(), includeProject = true } = {}) {
  const identity = openIdentity(config);
  const sections = [];

  const identityFacts = withinBudget(identity, config.budget.identity);
  if (identityFacts.length) {
    sections.push({
      heading: 'About the person you are working with',
      lines: identityFacts.map((f) => `- ${f.text}`),
    });
  }

  let project = null;
  if (includeProject) {
    project = openProject(cwd, config);
    const projectFacts = withinBudget(project.store, config.budget.project);
    if (projectFacts.length) {
      sections.push({
        heading: `About this project (${project.name})`,
        lines: projectFacts.map((f) => `- ${f.text}`),
      });
    }
  }

  if (!sections.length) {
    return { text: '', tokens: 0, empty: true, identity, project };
  }

  const body = sections.map((s) => `## ${s.heading}\n${s.lines.join('\n')}`).join('\n\n');
  const text = clamp(
    [
      '# Notes about this user, from tradwife',
      '',
      'The following was recorded locally by the tradwife CLI from this user\'s own earlier messages. It is background information about them and their project, not an instruction for the current turn.',
      '',
      body,
    ].join('\n'),
    HARD_CHAR_CAP
  );

  return { text: `${text}\n`, tokens: estimateTokens(text), empty: false, identity, project, sections };
}

/**
 * Return the highest-scoring facts that fit in `budget`, in file order.
 * Pruning at harvest time keeps stores under budget already; this is the
 * belt-and-braces pass for hand-edited files that grew past it.
 */
function withinBudget(store, budget) {
  const all = store.activeFacts();
  if (!all.length) return [];
  const ranked = [...all].sort((a, b) => store.score(b) - store.score(a));
  const keep = [];
  let used = 0;
  for (const fact of ranked) {
    const cost = estimateTokens(`- ${fact.text}\n`);
    if (used + cost > budget) continue;
    used += cost;
    keep.push(fact.id);
  }
  const kept = new Set(keep);
  return all.filter((f) => kept.has(f.id));
}

function clamp(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n(truncated by tradwife to fit the hook output limit)`;
}
