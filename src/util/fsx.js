import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Create a directory (and parents) if it does not exist. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a file atomically: write to a sibling temp file, fsync, then rename.
 * A crash mid-write can never leave a half-written memory file behind.
 */
export function writeAtomic(file, contents) {
  ensureDir(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is unavailable on some filesystems; the rename below is still atomic */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function readJSON(file, fallback = null) {
  const raw = readText(file);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt file must never crash a hook. Quarantine it and start clean.
    try {
      fs.renameSync(file, `${file}.corrupt.${Date.now()}`);
    } catch {
      /* best effort */
    }
    return fallback;
  }
}

export function writeJSON(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

/** Read a .jsonl file, skipping any lines that fail to parse. */
export function readLines(file) {
  const raw = readText(file);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function tmpDir(prefix = 'tradwife-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
