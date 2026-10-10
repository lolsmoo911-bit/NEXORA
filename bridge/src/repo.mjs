/**
 * NEXORA — repository access for the bridge.
 *
 * HARD RULE: this module never spawns a shell. Git is invoked as an executable with a
 * fixed, validated argument list, restricted to the configured workspace and limited to
 * read-only verbs plus an explicitly allowlisted subset of write verbs that the owner
 * asked for (opencode_submit_task drives the agent; this module only *reads*).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config, redact } from './config.mjs';
import { BridgeError } from './opencode-client.mjs';

const run = promisify(execFile);

/** Only these git subcommands are reachable. Anything else is refused by design. */
const ALLOWED_GIT_VERBS = new Set(['status', 'diff', 'log', 'rev-parse', 'branch', 'show', 'ls-files']);

function assertInsideWorkspace(target, cfg = config) {
  const resolved = path.resolve(target);
  const root = cfg.workspaceRoot;
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new BridgeError(`path escapes the workspace: ${resolved}`, 'forbidden');
  }
  return resolved;
}

async function git(args, { cwd, maxBuffer, timeout = 20000 } = {}, cfg = config) {
  const workdir = assertInsideWorkspace(cwd || cfg.workspaceRoot, cfg);
  const verb = args[0];
  if (!ALLOWED_GIT_VERBS.has(verb)) {
    // Defence in depth: even though callers are internal, refuse anything unexpected.
    throw new BridgeError(`git verb not allowed: ${verb}`, 'forbidden');
  }
  try {
    const { stdout } = await run('git', args, {
      cwd: workdir,
      maxBuffer: Math.max(maxBuffer || 1024 * 1024, 1024 * 1024),
      timeout,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' }
    });
    return stdout;
  } catch (err) {
    const message = redact(err?.stderr || err?.message || String(err));
    throw new BridgeError(`git ${verb} failed: ${message.slice(0, 400)}`, 'git_failed');
  }
}

/** Working-tree status, including untracked files, as structured data. */
export async function nexoraGitStatus(cfg = config) {
  const porcelain = await git(['status', '--porcelain=v1', '--branch'], { cwd: cfg.workspaceRoot }, cfg);
  const lines = porcelain.split('\n').filter(Boolean);
  const branchLine = lines.find((l) => l.startsWith('##')) || '';
  const entries = lines
    .filter((l) => !l.startsWith('##'))
    .map((l) => ({
      status: l.slice(0, 2).trim() || '??',
      path: l.slice(3).trim()
    }));
  return {
    branch: branchLine.replace(/^##\s*/, '').split('...')[0] || null,
    aheadBehind: branchLine.includes('...') ? branchLine.split('...')[1].trim() : null,
    clean: entries.length === 0,
    changedCount: entries.length,
    entries: entries.slice(0, 200)
  };
}

/**
 * A bounded diff. Defaults to unstaged+staged against HEAD.
 * `ref` must look like a git revision and is passed as a single argument (no shell).
 */
export async function nexoraDiff({ ref = 'HEAD', staged = false, path: sub } = {}, cfg = config) {
  if (!/^[A-Za-z0-9._/~^@-]+$/.test(ref)) {
    throw new BridgeError(`ref contains unsupported characters: ${ref}`, 'invalid_input');
  }
  const args = ['diff'];
  if (!staged) args.push('HEAD');
  args.push('--no-color', '--stat', '--patch');
  args.push(ref);
  if (sub) {
    if (sub.includes('..')) throw new BridgeError('path filter may not contain ..', 'invalid_input');
    args.push('--', sub);
  }
  const out = await git(args, { cwd: cfg.workspaceRoot, maxBuffer: cfg.limits.maxDiffBytes }, cfg);
  const bounded = out.length > cfg.limits.maxDiffBytes
    ? out.slice(0, cfg.limits.maxDiffBytes) + `\n... [truncated at ${cfg.limits.maxDiffBytes} bytes]`
    : out;
  return { ref, staged, bytes: out.length, truncated: out.length > cfg.limits.maxDiffBytes, diff: redact(bounded) };
}

/** Recent commits, bounded. */
export async function nexoraLog(limit = 20, cfg = config) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));
  const out = await git(['log', `-${n}`, '--pretty=format:%H%x09%an%x09%aI%x09%s'], { cwd: cfg.workspaceRoot }, cfg);
  return {
    commits: out.split('\n').filter(Boolean).map((line) => {
      const [sha, author, date, ...subject] = line.split('\t');
      return { sha, author, date, subject: subject.join('\t') };
    })
  };
}

/** Current commit SHA and a few identity facts. */
export async function nexoraHeadInfo(cfg = config) {
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: cfg.workspaceRoot }, cfg)).trim();
  let dirty = true;
  try {
    const st = await nexoraGitStatus(cfg);
    dirty = !st.clean;
  } catch { /* status is best-effort here */ }
  return { sha, dirty };
}

/** Small, bounded listing of the docs/ directory so a reviewer can see what exists. */
export async function nexoraDocsIndex(cfg = config) {
  const dir = assertInsideWorkspace(path.join(cfg.workspaceRoot, 'docs'), cfg);
  try {
    const names = await fs.readdir(dir);
    const files = [];
    for (const name of names.slice(0, 100)) {
      const full = path.join(dir, name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat?.isFile()) files.push({ name, bytes: stat.size });
    }
    return { files };
  } catch (err) {
    throw new BridgeError(`cannot read docs/: ${redact(err.message)}`, 'io_failed');
  }
}
