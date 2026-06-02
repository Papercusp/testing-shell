/**
 * testing-domain-glob.ts — minimal dependency-free glob walker for the
 * /api/admin/testing/domains/:id route (P-003).
 *
 * We deliberately don't pull in `fast-glob` / `globby` / `minimatch` to
 * avoid touching `apps/operator/package.json` (another agent commonly
 * holds it during edits). The patterns we need are simple and bounded:
 *
 *   path/literal.test.ts
 *   path/*.test.ts
 *   path/**\/*.test.ts
 *   path/[brace,alt]*.test.ts   (single-level brace expansion)
 *   path/!(except)/**           (negation — NOT supported, error out)
 *
 * Walks under a workspace-relative root, finds files matching each glob,
 * returns {path, sizeBytes, mtimeMs} per file. Implementation:
 *   1. Split the pattern into a literal prefix (everything before the
 *      first metachar) and a remainder regex.
 *   2. Walk fs.readdir recursively from the prefix.
 *   3. Test each file against the remainder regex.
 *
 * Skips node_modules, .git, dist, .next, .turbo, .pnpm at the directory
 * level — never recurse into them.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync, type Dirent } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  '.svelte-kit',
  '.cache',
]);

export interface FileHit {
  path: string;        // workspace-relative, POSIX
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Throw on brace alternation or extglob (`!()`, `?()`, `@()`) — we don't
 * support them and silently mis-matching would be worse than a clear
 * error at registry-walk time.
 */
function assertSupportedPattern(pat: string): void {
  if (/[!?@+]\(/.test(pat)) {
    throw new Error(`testing-domain-glob: unsupported extglob in "${pat}"`);
  }
  if (pat.includes('{') || pat.includes('}')) {
    throw new Error(`testing-domain-glob: brace alternation not supported in "${pat}"`);
  }
}

/**
 * Split a glob into [literalPrefix, remainder]. The literal prefix is
 * the longest leading subpath that contains no glob metachars; the
 * walker starts here. Remainder is the regex-eligible suffix.
 */
export function splitPrefix(pattern: string): [string, string] {
  // Find first metachar.
  const meta = pattern.search(/[*?[]/);
  if (meta < 0) return [pattern, ''];
  // Back up to the previous path boundary.
  const cut = pattern.lastIndexOf('/', meta);
  if (cut < 0) return ['', pattern];
  return [pattern.slice(0, cut), pattern.slice(cut + 1)];
}

/**
 * Convert a glob remainder (after splitPrefix) to a RegExp anchored to
 * match a path RELATIVE to the prefix dir.
 *
 *   *           → [^/]*
 *   **          → .*
 *   ?           → [^/]
 *   .           → \.
 *   /           → /
 *   anything    → literal
 */
export function remainderToRegex(rem: string): RegExp {
  assertSupportedPattern(rem);
  let out = '^';
  for (let i = 0; i < rem.length; i++) {
    const c = rem[i];
    if (c === '*') {
      if (rem[i + 1] === '*') {
        out += '.*';
        i++;
        if (rem[i + 1] === '/') i++; // consume the `/` after `**/`
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (/[.+^$()|\\[\]]/.test(c)) {
      // Escape regex metachars — INCLUDING `[` and `]` so literal
      // Next.js dynamic-route dirs (`app/users/github/[id]/...`) match
      // as literals instead of being mis-read as a regex char class.
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

/**
 * Recursively list files under `dir`. Returns paths relative to `dir`
 * with POSIX separators. Skips IGNORE_DIRS at the directory level so
 * we never walk into them.
 */
async function walk(dir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const sub = await walk(join(dir, e.name));
      for (const s of sub) out.push(posix.join(e.name, s));
    } else if (e.isFile()) {
      out.push(e.name);
    }
  }
  return out;
}

/**
 * Resolve all hits for a single glob, anchored at `workspaceRoot`.
 */
export async function expandGlob(
  workspaceRoot: string,
  pattern: string,
): Promise<FileHit[]> {
  assertSupportedPattern(pattern);
  const [prefix, remainder] = splitPrefix(pattern);
  const start = prefix ? join(workspaceRoot, prefix) : workspaceRoot;

  // No remainder = a literal file path.
  if (!remainder) {
    try {
      const s = await stat(start);
      if (!s.isFile()) return [];
      return [
        {
          path: prefix,
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
        },
      ];
    } catch {
      return [];
    }
  }

  const re = remainderToRegex(remainder);
  const rels = await walk(start);
  const hits: FileHit[] = [];
  for (const rel of rels) {
    if (!re.test(rel)) continue;
    const full = join(start, rel);
    try {
      const s = await stat(full);
      hits.push({
        path: prefix ? posix.join(prefix, rel) : rel,
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // race with concurrent fs change; skip.
    }
  }
  return hits;
}

/**
 * Resolve a list of globs, dedupe hits by path, sort by path ascending.
 */
export async function expandGlobs(
  workspaceRoot: string,
  patterns: string[],
): Promise<FileHit[]> {
  const seen = new Map<string, FileHit>();
  for (const pat of patterns) {
    const hits = await expandGlob(workspaceRoot, pat);
    for (const h of hits) {
      if (!seen.has(h.path)) seen.set(h.path, h);
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

/**
 * Resolve the workspace root from any path inside the repo. Walks up
 * looking for `pnpm-workspace.yaml`; falls back to the first ancestor
 * containing `.git`. The Hono host runs with cwd=apps/operator, so
 * trusting `process.cwd()` would land us two levels down from the root
 * and miss every repo-relative glob.
 *
 * Result is memoized for the process lifetime — workspace root never
 * moves while the dev server is alive.
 */
let _cachedRoot: string | null = null;
export function inferWorkspaceRoot(from = process.cwd()): string {
  if (_cachedRoot) return _cachedRoot;
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      _cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: walk up looking for .git.
  dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, '.git'))) {
      _cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _cachedRoot = from;
  return from;
}

/** INTERNAL — test-only. Reset the cached workspace root. */
export function _resetWorkspaceRootCache(): void {
  _cachedRoot = null;
}
