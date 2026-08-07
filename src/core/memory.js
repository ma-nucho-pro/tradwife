import path from 'node:path';
import { Store } from './store.js';
import { loadConfig } from './config.js';
import { paths, findProjectRoot, projectKey, homeRelative } from '../util/paths.js';
import { ensureDir, readJSON, writeJSON, listDir } from '../util/fsx.js';

const IDENTITY_HEADER =
  '<!-- This file is yours. Edit it by hand, reorder it, delete lines you disagree with.\n' +
  '     tradwife reads your edits back on the next run: a line you delete is forgotten,\n' +
  '     a line you add is kept at full confidence. Metadata lives in identity.index.json. -->';

const PROJECT_HEADER =
  '<!-- Project memory. Same rules as identity.md: hand edits win. -->';

export function openIdentity(config = loadConfig()) {
  ensureDir(paths.home());
  return new Store({
    mdPath: paths.identity(),
    indexPath: paths.identityIndex(),
    sections: config.identitySections,
    title: 'Tradwife · who you are',
    header: IDENTITY_HEADER,
    halfLife: config.halfLife.identity,
    scope: 'user',
  }).load();
}

export function resolveProject(cwd = process.cwd()) {
  const root = findProjectRoot(cwd);
  return { root, key: projectKey(root), name: path.basename(root) };
}

export function openProject(cwd = process.cwd(), config = loadConfig()) {
  const { root, key, name } = resolveProject(cwd);
  ensureDir(paths.projectDir(key));

  const metaPath = paths.projectMeta(key);
  const meta = readJSON(metaPath, null) || { key, root, name, created: new Date().toISOString() };
  meta.root = root;
  meta.name = name;
  meta.lastSeen = new Date().toISOString();
  writeJSON(metaPath, meta);

  const store = new Store({
    mdPath: paths.projectMd(key),
    indexPath: paths.projectIndex(key),
    sections: config.projectSections,
    title: `Tradwife · ${name}`,
    header: `${PROJECT_HEADER}\n<!-- ${homeRelative(root)} -->`,
    halfLife: config.halfLife.project,
    scope: `project:${key}`,
  }).load();

  return { store, meta, key, root, name };
}

/** Every project tradwife has ever seen, most recently used first. */
export function listProjects() {
  return listDir(paths.projects())
    .map((key) => readJSON(paths.projectMeta(key), null))
    .filter(Boolean)
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}
