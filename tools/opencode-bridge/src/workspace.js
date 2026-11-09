import { realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config, parseRootList } from './config.js';

/**
 * Resolve short (8.3-style) path segments against ancestor directories that
 * exist, so C:\\Users\\ADMINI~1\\... compares correctly with C:\\Users\\Administrator.
 * Falls back to the input when nothing can be canonicalized.
 */
export function normalizeRealPath(candidate) {
  let probe = resolve(candidate);
  let tail = '';
  while (true) {
    try {
      statSync(probe);
      break;
    } catch {
      const parent = resolve(probe, '..');
      if (parent === probe) break; // reached the drive root with nothing existing
      tail = tail ? `${relative(parent, probe)}${sep}${tail}` : relative(parent, probe);
      probe = parent;
    }
  }
  try {
    const real = realpathSync(probe);
    return tail ? join(real, tail) : real;
  } catch {
    return resolve(candidate);
  }
}

/**
 * Approved workspace roots. Configured through BRIDGE_WORKSPACE_ROOTS; falls back
 * to BRIDGE_DIRECTORY when set. If nothing is configured, file *reads* fall back
 * to the user's home directory and file *writes* must stay disabled.
 */
export function workspaceRoots() {
  const configured = parseRootList();
  if (configured.length) return configured.map((root) => normalizeRealPath(root));
  if (config.directory) return [normalizeRealPath(config.directory)];
  return [normalizeRealPath(homedir())];
}

export function writeRoots() {
  const roots = workspaceRoots();
  return roots.some((root) => root !== resolve(homedir())) ? roots : [];
}

export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * Resolve a user-supplied path against an optional directory and verify that the
 * result stays inside an approved workspace root. Protects against path traversal
 * (.. segments, absolute escapes, drive changes).
 */
export function withinRoots(entryPath, { directory, forWrite = false } = {}) {
  if (!entryPath || typeof entryPath !== 'string') throw new WorkspaceError('path is required.');
  // Reject Windows drive letters and UNC paths on all platforms: they cannot be
  // canonicalized safely on a POSIX host and must never escape the workspace.
  if (/^[A-Za-z]:[\\/]/.test(entryPath) || /^\\\\/.test(entryPath)) {
    throw new WorkspaceError('Windows-style paths are not allowed in the workspace.');
  }
  const candidate = isAbsolute(entryPath) ? entryPath : join(directory || '', entryPath);
  const target = normalizeRealPath(candidate);
  const roots = (forWrite ? writeRoots() : workspaceRoots()).map((root) => normalizeRealPath(root));
  if (!roots.length) {
    throw new WorkspaceError(
      'No approved workspace root is configured. Set BRIDGE_WORKSPACE_ROOTS (semicolon separated) in the bridge environment.',
    );
  }
  const inside = roots.some((root) => {
    const rel = relative(root, target);
    return !rel.startsWith('..') && !isAbsolute(rel) && (rel.length ? true : true);
  });
  if (!inside) {
    throw new WorkspaceError(
      `Path is outside the approved workspace directories (${roots.join(' ; ')}).`,
    );
  }
  return target;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  '.cache',
]);

const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.exe',
  '.dll',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.mov',
  '.wav',
  '.sqlite',
  '.db',
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 4000;

/**
 * Bounded text search inside one workspace root. Skips binary-heavy directories
 * and files; never follows symlinks out of the root.
 */
export async function searchText({ query, directory, regex = false, caseSensitive = false, limit = 50 } = {}) {
  if (!query) throw new WorkspaceError('query is required.');
  const root = withinRoots(directory || '.', {});
  const matcher = regex
    ? new RegExp(query, caseSensitive ? 'g' : 'gi')
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');

  const matches = [];
  let scanned = 0;
  let skipped = 0;
  const pending = [root];

  while (pending.length && matches.length < limit && scanned < MAX_FILES) {
    const current = pending.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    for (const entry of entries) {
      if (matches.length >= limit || scanned >= MAX_FILES) break;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped += 1;
          continue;
        }
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_EXTENSIONS.has(entry.name.toLowerCase().slice(entry.name.lastIndexOf('.')))) {
        skipped += 1;
        continue;
      }
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      let content;
      try {
        content = await readFile(full, 'utf8');
      } catch {
        skipped += 1;
        continue;
      }
      scanned += 1;
      if (content.includes('\0')) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        matcher.lastIndex = 0;
        if (matcher.test(lines[index])) {
          matches.push({
            file: relative(root, full) || entry.name,
            line: index + 1,
            text: lines[index].slice(0, 240),
          });
        }
      }
    }
  }

  return { root, matches, scanned, truncated: matches.length >= limit || scanned >= MAX_FILES || pending.length > 0 };
}

export { SKIP_DIRS, SKIP_EXTENSIONS, MAX_FILE_BYTES, MAX_FILES };
