const useColor =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  !process.env.TRADWIFE_NO_COLOR;

const wrap = (open, close) => (s) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const say = (...args) => console.log(...args);
export const blank = () => console.log('');
export const warn = (msg) => console.log(`${c.yellow('!')} ${msg}`);
export const fail = (msg) => console.error(`${c.red('x')} ${msg}`);
export const ok = (msg) => console.log(`${c.green('✓')} ${msg}`);
export const info = (msg) => console.log(`${c.cyan('·')} ${msg}`);

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function heading(text) {
  console.log(`\n${c.bold(text)}`);
}

export function bullet(text, meta) {
  console.log(`  ${c.dim('-')} ${text}${meta ? ` ${c.gray(meta)}` : ''}`);
}

/** Render a token count with a visual sense of how much budget is left. */
export function meter(used, budget, width = 24) {
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0;
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = ratio > 0.95 ? c.red : ratio > 0.75 ? c.yellow : c.green;
  return `${color(bar)} ${used}/${budget} tokens`;
}

/** Read all of stdin. Returns '' immediately when stdin is a TTY. */
export function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}
