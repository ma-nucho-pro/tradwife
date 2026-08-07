import crypto from 'node:crypto';

/**
 * Token estimate. Deliberately dependency-free: no tokenizer download, no wasm.
 * Calibrated against mixed Spanish/English markdown prose, which lands around
 * 3.6 characters per token. Expect +/-15%; the budget headroom absorbs it.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.6);
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. Used for identity hashing. */
export function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable content-addressed id for a fact. Same meaning, same id, across machines. */
export function factId(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex').slice(0, 10);
}

const STOPWORDS = new Set([
  // es
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','y','o','que','se','es','son',
  'con','por','para','su','sus','lo','le','me','mi','mis','te','tu','tus','como','mas','pero','este',
  'esta','estos','estas','ese','esa','muy','ya','sin','sobre','hay','ser','estar',
  // Verbs are NOT stopwords here. They were, and it quietly gutted the
  // contradiction check: "usa" was stripped before the lemma table could map
  // it, so "Usa Redis" and "nunca uso Redis" ended up sharing nothing.
  // en
  'the','a','an','of','to','in','on','for','and','or','that','this','these','those','is','are','be','been',
  'with','by','it','its','as','at','from','my','your','i','we','you','do','does','not',
]);

/**
 * Conjugated forms of the verbs that actually carry meaning in a memory file,
 * mapped to one lemma each.
 *
 * Without this, "Usa Redis" and "nunca uso Redis" share no verb token at all,
 * so the contradiction check never fired and both statements sat in the file
 * disagreeing with each other. A general stemmer would catch more and also
 * collide unrelated words (casa/caso); a short explicit table catches the cases
 * that occur and cannot invent a match.
 */
const LEMMA = new Map();
for (const [lemma, forms] of [
  ['usar', 'uso usas usa usamos usais usan usar usando usado usada usados utilizo utilizas utiliza utilizamos utilizan utilizar utilizando'],
  ['preferir', 'prefiero prefieres prefiere preferimos prefieren preferir prefiriendo'],
  ['trabajar', 'trabajo trabajas trabaja trabajamos trabajan trabajar trabajando'],
  ['hacer', 'hago haces hace hacemos hacen hacer haciendo'],
  ['escribir', 'escribo escribes escribe escribimos escriben escribir escribiendo'],
  ['ejecutar', 'ejecuto ejecutas ejecuta ejecutamos ejecutan ejecutar corro corre corremos corren correr'],
  ['evitar', 'evito evitas evita evitamos evitan evitar evitando'],
  ['querer', 'quiero quieres quiere queremos quieren querer'],
  ['responder', 'respondo respondes responde respondemos responden responder respondiendo respuesta respuestas'],
  ['desplegar', 'despliego despliega desplegamos despliegan desplegar deploy deploys'],
  ['use', 'use uses using used'],
  ['prefer', 'prefer prefers preferring preferred'],
  ['write', 'write writes writing wrote written'],
  ['run', 'run runs running ran'],
  ['avoid', 'avoid avoids avoiding avoided'],
  ['answer', 'answer answers answering answered reply replies replying'],
  ['deploy', 'deploy deploys deploying deployed'],
]) {
  for (const form of forms.split(' ')) LEMMA.set(form, lemma);
}

export function tokensOf(text) {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => LEMMA.get(w) || w);
}

/** Jaccard similarity over content words. Cheap near-duplicate detection, no embeddings. */
export function similarity(a, b) {
  const A = new Set(tokensOf(a));
  const B = new Set(tokensOf(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * True when one statement is a strictly more detailed version of the other:
 * every content word of the shorter appears in the longer, and the longer adds
 * something. "Prefers short answers" refines into "Prefers short direct answers".
 *
 * This replaces a plain similarity threshold, which was quietly wrong. Two long
 * statements differing by one word — "deploys to production every Friday" and
 * "deploys to staging every Friday" — score above any useful similarity cutoff
 * while meaning different things. A subset test cannot make that mistake:
 * each has a word the other lacks, so they stay separate facts.
 *
 * @returns {0|1|-1} 1 if b refines a, -1 if a refines b, 0 if neither.
 */
export function refines(a, b) {
  const A = new Set(tokensOf(a));
  const B = new Set(tokensOf(b));
  if (A.size < 2 || B.size < 2) return 0;
  const subset = (X, Y) => [...X].every((w) => Y.has(w));
  if (A.size === B.size && subset(A, B)) return 1; // same content words, different wording
  if (subset(A, B)) return 1;
  if (subset(B, A)) return -1;
  return 0;
}

const NEGATIONS = new Set(['no', 'not', 'never', 'nunca', 'jamas', 'sin', 'dont', "don't", 'ya no', 'evitar', 'evita']);

/**
 * True when two facts say the opposite thing about the same subject: identical
 * content words, but exactly one of them carries a negation.
 */
export function contradicts(a, b) {
  const hasNeg = (t) => normalize(t).split(' ').some((w) => NEGATIONS.has(w));
  if (hasNeg(a) === hasNeg(b)) return false;

  // Compare by containment, not by a similarity threshold. "Nunca uso Redis"
  // and "Usa Redis para la caché" are a plain contradiction, but the second
  // carries extra detail, so their overlap scores well under any threshold
  // loose enough to be safe. Asking instead whether one statement's content
  // words all appear in the other catches the asymmetry and still refuses to
  // fire on "Usa Postgres" vs "Nunca usa MySQL", where each has a word the
  // other lacks.
  const strip = (t) => new Set(tokensOf(t).filter((w) => !NEGATIONS.has(w)));
  const A = strip(a);
  const B = strip(b);
  if (A.size < 2 || B.size < 2) return false;
  const subset = (X, Y) => [...X].every((w) => Y.has(w));
  return subset(A, B) || subset(B, A);
}

export function titleCase(text) {
  const t = String(text).trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

/** Collapse whitespace, drop trailing filler punctuation, cap the length. */
export function tidy(text, maxLen = 180) {
  let t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`*\-–—:,.]+/, '')
    .replace(/[\s,;:.!]+$/, '');
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    t = `${(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  return t;
}

export function wordCount(text) {
  return normalize(text).split(' ').filter(Boolean).length;
}

export function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
