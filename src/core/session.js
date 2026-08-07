import { paths, safeId } from '../util/paths.js';
import { ensureDir, appendLine, readLines, removeFile, listDir, exists } from '../util/fsx.js';
import path from 'node:path';

/**
 * Session buffers are the only place raw prompt text is stored, and only until
 * the session is harvested. They exist so harvesting can apply the
 * "seen in N distinct sessions" rule without re-reading agent transcripts,
 * whose format is not a stable contract.
 */

export function appendPrompt(sessionId, { prompt, cwd, agent }) {
  ensureDir(paths.sessions());
  appendLine(paths.session(sessionId), {
    at: new Date().toISOString(),
    prompt: String(prompt || '').slice(0, 20_000),
    cwd: cwd || process.cwd(),
    agent: agent || 'unknown',
  });
}

export function readSession(sessionId) {
  return readLines(paths.session(sessionId));
}

export function dropSession(sessionId) {
  return removeFile(paths.session(sessionId));
}

export function listSessions() {
  return listDir(paths.sessions())
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.basename(f, '.jsonl'));
}

export function sessionExists(sessionId) {
  return exists(paths.session(safeId(sessionId)));
}
