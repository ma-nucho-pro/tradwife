import { tidy, wordCount, normalize, titleCase } from '../util/text.js';
import { detectSecret } from './redact.js';

/**
 * Candidate extraction.
 *
 * Two decisions define this module.
 *
 * 1. It only ever reads what *you* typed. The agent's own replies are never
 *    mined. A model that suggests "let's use Postgres" and hears "ok" back has
 *    not learned a fact about you; it has heard its own idea repeated. Most
 *    memory tools blur this and end up remembering their own suggestions.
 *
 * 2. It prefers to miss a fact over inventing one. Every rule below is anchored
 *    to a phrase a person uses when they are stating something durable, and a
 *    battery of rejections throws out tasks, questions and pasted noise. A
 *    memory you have to constantly correct is worse than no memory.
 */

/** Sentence-initial verbs that mean "do this now", not "know this about me". */
const TASK_VERBS = [
  'haz', 'hazme', 'dame', 'crea', 'créame', 'creame', 'arregla', 'corrige', 'implementa', 'escribe',
  'agrega', 'añade', 'anade', 'borra', 'elimina', 'refactoriza', 'revisa', 'explica', 'muestra',
  'busca', 'genera', 'instala', 'ejecuta', 'analiza', 'traduce', 'documenta', 'testea', 'prueba',
  'necesito que', 'quiero que', 'puedes', 'podrias', 'podrías', 'ayudame', 'ayúdame', 'continua', 'continúa',
  'make', 'give', 'create', 'fix', 'implement', 'write', 'add', 'remove', 'delete', 'refactor',
  'review', 'explain', 'show', 'find', 'generate', 'install', 'run', 'analyze', 'translate',
  'document', 'test', 'build', 'update', 'change', 'help', 'can you', 'could you', 'please',
];

const SELF_WORDS = new Set([
  // Spanish first-person markers, including the conjugated verbs that actually
  // show up in prompts. Missing these sent "nunca hago deploy los viernes" —
  // plainly a fact about the person — into project memory.
  'yo', 'me', 'mi', 'mis', 'conmigo', 'soy', 'estoy', 'tengo', 'hago', 'uso', 'utilizo', 'trabajo',
  'vivo', 'hablo', 'escribo', 'prefiero', 'suelo', 'acostumbro', 'odio', 'detesto', 'llamo',
  'quiero', 'necesito', 'evito', 'reviso', 'programo', 'aprendo', 'estudio',
  'i', 'im', 'my', 'mine', 'myself', 'prefer', 'live', 'speak', 'hate', 'love', 'work', 'usually',
]);

const STYLE_WORDS = new Set([
  'responde', 'respuesta', 'respuestas', 'explica', 'explicacion', 'tono', 'idioma', 'espanol',
  'ingles', 'conciso', 'corto', 'cortas', 'breve', 'directo', 'directas', 'detalle', 'formato',
  'answer', 'answers', 'reply', 'replies', 'respond', 'tone', 'language', 'concise', 'short',
  'brief', 'verbose', 'format', 'explain', 'english', 'spanish',
]);

const PROJECT_WORDS = new Set([
  'repo', 'repositorio', 'proyecto', 'codigo', 'rama', 'branch', 'deploy', 'build', 'test', 'tests',
  'migracion', 'endpoint', 'componente', 'modulo', 'paquete', 'carpeta', 'archivo', 'base', 'datos',
  'api', 'schema', 'esquema', 'servidor', 'cliente', 'stack', 'aqui', 'este',
  'project', 'codebase', 'module', 'package', 'folder', 'file', 'database', 'server', 'client',
  'here', 'this', 'repository', 'service', 'lint', 'ci',
  // version control and delivery vocabulary: "never commit directly to main" is
  // about the repo, not about you.
  'commit', 'commits', 'merge', 'push', 'pull', 'rebase', 'main', 'master', 'dev', 'staging',
  'prod', 'produccion', 'release', 'tag', 'pipeline', 'docker', 'migrations', 'migraciones',
  'seed', 'env', 'lockfile', 'monorepo', 'workspace',
]);

/**
 * Rules are ordered: the first one that matches a sentence wins, so the most
 * specific phrasings sit at the top.
 * - `explicit: true` bypasses the two-session promotion rule. You said it on
 *   purpose, so it is remembered on the spot.
 */
/**
 * Facts are rendered in the language they were spoken in. Prefixing Spanish
 * content with an English label produced lines like "Prefers respuestas
 * cortas", which read as broken in the one place it matters most: the block the
 * agent is handed at the start of every session.
 */
const LABEL = {
  es: { prefers: 'Prefiere', dislikes: 'No le gusta', avoid: 'Evitar:', uses: 'Usa', name: 'Se llama', livesIn: 'Vive en', worksAt: 'Trabaja en', worksAs: 'Trabaja como', is: 'Es' },
  en: { prefers: 'Prefers', dislikes: 'Dislikes', avoid: 'Avoid:', uses: 'Uses', name: 'Name:', livesIn: 'Based in', worksAt: 'Works at', worksAs: 'Works as', is: 'Is' },
};

const RULES = [
  {
    id: 'es.directive',
    lang: 'es',
    kind: 'directive',
    confidence: 0.95,
    explicit: true,
    pattern: /\b(?:recuérda(?:me)?|recuerda(?:me)?|no\s+olvides|ten\s+en\s+cuenta|toma\s+en\s+cuenta|apunta|anota)\s+(?:que\s+)?(.{8,200}?)(?=[.;\n]|$)/giu,
    render: (m) => m[1],
  },
  {
    id: 'en.directive',
    lang: 'en',
    kind: 'directive',
    confidence: 0.95,
    explicit: true,
    pattern: /\b(?:remember|keep\s+in\s+mind|bear\s+in\s+mind|don'?t\s+forget|note)\s+(?:that\s+)?(.{8,200}?)(?=[.;\n]|$)/giu,
    render: (m) => m[1],
  },
  {
    id: 'es.rule',
    lang: 'es',
    kind: 'rule',
    confidence: 0.85,
    explicit: true,
    pattern: /\b(siempre|nunca|jamás|jamas)\s+(.{8,180}?)(?=[.;\n]|$)/giu,
    render: (m) => `${m[1]} ${m[2]}`,
  },
  {
    id: 'en.rule',
    lang: 'en',
    kind: 'rule',
    confidence: 0.85,
    explicit: true,
    pattern: /\b(always|never)\s+(.{8,180}?)(?=[.;\n]|$)/giu,
    render: (m) => `${m[1]} ${m[2]}`,
  },
  {
    id: 'es.constraint',
    lang: 'es',
    kind: 'constraint',
    confidence: 0.8,
    explicit: true,
    pattern: /\bno\s+(?:uses|utilices|quiero|me\s+gusta|pongas|agregues|añadas|anadas)\s+(.{6,160}?)(?=[.;\n]|$)/giu,
    render: (m) => `${LABEL.es.avoid} ${m[1]}`,
  },
  {
    id: 'en.constraint',
    lang: 'en',
    kind: 'constraint',
    confidence: 0.8,
    explicit: true,
    pattern: /\b(?:don'?t\s+use|do\s+not\s+use|avoid\s+using|avoid)\s+(.{6,160}?)(?=[.;\n]|$)/giu,
    render: (m) => `${LABEL.en.avoid} ${m[1]}`,
  },
  {
    id: 'es.preference',
    lang: 'es',
    kind: 'preference',
    confidence: 0.7,
    pattern: /\b(?:prefiero|me\s+gusta\s+más|me\s+gusta\s+mas|odio|detesto|no\s+soporto)\s+(.{6,160}?)(?=[.;\n]|$)/giu,
    render: (m, sentence) => (/odio|detesto|no\s+soporto/i.test(sentence) ? `${LABEL.es.dislikes} ${m[1]}` : `${LABEL.es.prefers} ${m[1]}`),
  },
  {
    id: 'en.preference',
    lang: 'en',
    kind: 'preference',
    confidence: 0.7,
    pattern: /\bi\s+(?:prefer|really\s+prefer|hate|dislike|can'?t\s+stand)\s+(.{6,160}?)(?=[.;\n]|$)/giu,
    render: (m, sentence) => (/hate|dislike|can'?t\s+stand/i.test(sentence) ? `${LABEL.en.dislikes} ${m[1]}` : `${LABEL.en.prefers} ${m[1]}`),
  },
  {
    id: 'es.identity',
    lang: 'es',
    kind: 'identity',
    confidence: 0.85,
    pattern: /\b(?:me\s+llamo|mi\s+nombre\s+es|soy|trabajo\s+en|trabajo\s+como|vivo\s+en|estoy\s+basado\s+en)\s+(.{3,120}?)(?=[.;\n]|$)/giu,
    render: (m, sentence) => {
      const lead = /me\s+llamo|mi\s+nombre\s+es/i.test(sentence) ? LABEL.es.name
        : /vivo\s+en|basado\s+en/i.test(sentence) ? LABEL.es.livesIn
          : /trabajo\s+en/i.test(sentence) ? LABEL.es.worksAt
            : /trabajo\s+como/i.test(sentence) ? LABEL.es.worksAs
              : LABEL.es.is;
      return `${lead} ${m[1]}`;
    },
  },
  {
    id: 'en.identity',
    lang: 'en',
    kind: 'identity',
    confidence: 0.85,
    pattern: /\bi(?:'m|\s+am)\s+(?:a\s+|an\s+)?(.{3,120}?)(?=[.;\n]|$)|\bmy\s+name\s+is\s+(.{2,80}?)(?=[.;\n]|$)|\bi\s+(?:live|work)\s+(?:in|at)\s+(.{2,80}?)(?=[.;\n]|$)/giu,
    render: (m) => {
      if (m[2]) return `${LABEL.en.name} ${m[2]}`;
      if (m[3]) return `${LABEL.en.livesIn} ${m[3]}`;
      return `${LABEL.en.is} ${m[1]}`;
    },
  },
  {
    id: 'es.stack',
    lang: 'es',
    kind: 'stack',
    confidence: 0.65,
    pattern: /\b(?:usamos|estamos\s+usando|vamos\s+a\s+usar|migramos\s+a|cambiamos\s+a|este\s+proyecto\s+usa)\s+(.{3,120}?)(?=[.;\n]|$)/giu,
    render: (m) => `${LABEL.es.uses} ${m[1]}`,
  },
  {
    id: 'en.stack',
    lang: 'en',
    kind: 'stack',
    confidence: 0.65,
    pattern: /\b(?:we\s+use|we'?re\s+using|we'?re\s+on|switching\s+to|migrated\s+to|this\s+project\s+uses)\s+(.{3,120}?)(?=[.;\n]|$)/giu,
    render: (m) => `${LABEL.en.uses} ${m[1]}`,
  },
];

/** Reasons a candidate is thrown away, in the order they are checked. */
export const REJECTIONS = {
  SECRET: 'looks like a credential',
  QUESTION: 'is a question',
  TASK: 'is a task, not a fact',
  TOO_SHORT: 'fewer than 3 content words',
  TOO_LONG: 'longer than 30 words',
  CODE: 'contains code or a path',
  PLACEHOLDER: 'is a pronoun or filler with no content',
  DENIED: 'matched a deny pattern from your config',
};

function looksLikeCode(text) {
  return (
    /```|\$\(|=>|;\s*$|\{\s*"|<\/?[a-z]+>/i.test(text) ||
    /(?:^|\s)(?:\/|\.\/|~\/|[A-Za-z]:\\)[\w./\\-]{6,}/.test(text) ||
    /https?:\/\//i.test(text) ||
    (text.match(/[{}()[\];=<>|]/g) || []).length >= 4
  );
}

function startsWithTaskVerb(text) {
  const n = normalize(text);
  return TASK_VERBS.some((v) => n === v || n.startsWith(`${v} `));
}

/**
 * @param {object} [options]
 * @param {boolean} [options.allowImperative] Accept imperative phrasing. Instruction
 *   files are written in the imperative ("Write tests with Vitest", "Use pnpm"),
 *   where it means a standing rule. In a live prompt the same words mean "do this
 *   now", so the task filter stays on by default and is only relaxed for import.
 */
export function judge(text, denyPatterns = [], options = {}) {
  // Judge the raw string, not the tidied one. tidy() truncates, and judging
  // after truncation let a 400-word paragraph pass as a clipped fragment.
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, reason: REJECTIONS.PLACEHOLDER };
  const secret = detectSecret(raw, denyPatterns);
  if (secret) return { ok: false, reason: REJECTIONS.SECRET, detail: secret };
  if (raw.includes('?') || raw.includes('¿')) return { ok: false, reason: REJECTIONS.QUESTION };
  if (!options.allowImperative && startsWithTaskVerb(raw)) return { ok: false, reason: REJECTIONS.TASK };
  if (looksLikeCode(raw)) return { ok: false, reason: REJECTIONS.CODE };
  // Two words is the floor, not three: a rendered fact like "Usa Kotlin" is
  // perfectly good, while the character minimum still throws out "ok sure".
  const words = wordCount(raw);
  if (words < 2 || raw.length < 8) return { ok: false, reason: REJECTIONS.TOO_SHORT };
  if (words > 30) return { ok: false, reason: REJECTIONS.TOO_LONG };
  const t = tidy(raw, 220);
  if (!t) return { ok: false, reason: REJECTIONS.PLACEHOLDER };
  return { ok: true, text: t };
}

/** user-scope facts are about the person; project-scope facts are about this codebase. */
export function classifyScope(text, kind) {
  const words = new Set(normalize(text).split(' '));
  const hits = (set) => [...words].filter((w) => set.has(w)).length;
  if (kind === 'identity' || kind === 'preference') return 'user';
  const style = hits(STYLE_WORDS);
  const self = hits(SELF_WORDS);
  const project = hits(PROJECT_WORDS);
  // Compare, do not short-circuit. An absolute "any style word wins" rule sent
  // "nunca hagas commit directo a main" to identity, because "directo" also
  // appears in "respuestas directas". Weighing the vocabularies against each
  // other keeps a single ambiguous word from deciding the outcome, and
  // first-person reference counts for more because "I never deploy on Fridays"
  // is a habit that follows you between repos.
  if (style + self * 1.5 > project) return 'user';
  if (project > 0) return 'project';
  return kind === 'directive' || kind === 'rule' ? 'user' : 'project';
}

const SECTION_BY_KIND = {
  user: {
    identity: 'Who', preference: 'Preferences', directive: 'Working style',
    rule: 'Working style', constraint: 'Constraints', stack: 'Working style',
  },
  project: {
    identity: 'Decisions', preference: 'Conventions', directive: 'Conventions',
    rule: 'Conventions', constraint: 'Conventions', stack: 'Stack',
  },
};

export function sectionFor(scope, kind) {
  return SECTION_BY_KIND[scope]?.[kind] || (scope === 'user' ? 'Who' : 'Decisions');
}

/** Split on sentence boundaries and newlines, keeping sentences short enough to be facts. */
function sentences(text) {
  return String(text)
    .split(/(?<=[.!?¡¿;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} prompt raw user prompt
 * @param {object} options
 * @returns {{candidates: Array, rejected: Array}}
 */
export function extract(prompt, { denyPatterns = [], maxChars = 4000 } = {}) {
  const candidates = [];
  const rejected = [];
  const raw = String(prompt || '');
  if (!raw.trim()) return { candidates, rejected };
  if (raw.length > maxChars) {
    return { candidates, rejected: [{ text: `<prompt of ${raw.length} chars>`, reason: 'prompt too long to mine safely' }] };
  }

  const seen = new Set();
  for (const sentence of sentences(raw)) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      let matchedThisRule = false;
      while ((match = rule.pattern.exec(sentence)) !== null) {
        if (match[0].length === 0) { rule.pattern.lastIndex++; continue; }
        const rendered = titleCase(tidy(rule.render(match, sentence)));
        const verdict = judge(rendered, denyPatterns);
        if (!verdict.ok) {
          rejected.push({ text: rendered, reason: verdict.reason, detail: verdict.detail, rule: rule.id });
          matchedThisRule = true;
          continue;
        }
        const key = normalize(verdict.text);
        if (seen.has(key)) { matchedThisRule = true; continue; }
        seen.add(key);
        const scope = classifyScope(verdict.text, rule.kind);
        candidates.push({
          text: verdict.text,
          kind: rule.kind,
          rule: rule.id,
          confidence: rule.confidence,
          explicit: Boolean(rule.explicit),
          scope,
          section: sectionFor(scope, rule.kind),
          evidence: tidy(sentence, 200),
        });
        matchedThisRule = true;
      }
      // First matching rule wins for a given sentence: stops "always use X" from
      // also firing the weaker stack rule on the same clause.
      if (matchedThisRule) break;
    }
  }
  return { candidates, rejected };
}

export const _internals = { RULES, TASK_VERBS, looksLikeCode, startsWithTaskVerb, sentences };
