/**
 * Tests for the dependency-free glob engine that powers the /admin/testing +
 * /adv Tests tab discovery (and which lint-tests.ts mirrors).
 * Run with: npx vitest run libs/testing-shell/src/glob.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitPrefix,
  remainderToRegex,
  expandGlob,
  expandGlobs,
  inferWorkspaceRoot,
  _resetWorkspaceRootCache,
  resolveNearestVitestConfig,
} from './glob';

describe('splitPrefix', () => {
  it('treats a literal path as all-prefix, no remainder', () => {
    expect(splitPrefix('a/b/c.test.ts')).toEqual(['a/b/c.test.ts', '']);
  });

  it('cuts at the last boundary before the first metachar', () => {
    expect(splitPrefix('a/b/*.test.ts')).toEqual(['a/b', '*.test.ts']);
    expect(splitPrefix('a/**/*.test.ts')).toEqual(['a', '**/*.test.ts']);
    expect(splitPrefix('pkg/[id]/x.ts')).toEqual(['pkg', '[id]/x.ts']);
  });

  it('returns an empty prefix when the metachar is in the first segment', () => {
    expect(splitPrefix('*.test.ts')).toEqual(['', '*.test.ts']);
  });
});

describe('remainderToRegex', () => {
  it('matches "*" within a single segment only', () => {
    const re = remainderToRegex('*.test.ts');
    expect(re.test('foo.test.ts')).toBe(true);
    expect(re.test('a/foo.test.ts')).toBe(false);
  });

  it('matches "**" across slashes', () => {
    const re = remainderToRegex('**/*.test.ts');
    expect(re.test('foo.test.ts')).toBe(true);
    expect(re.test('a/b/foo.test.ts')).toBe(true);
    expect(re.test('foo.ts')).toBe(false);
  });

  it('matches "?" as exactly one non-slash char', () => {
    const re = remainderToRegex('?.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('ab.ts')).toBe(false);
    expect(re.test('/.ts')).toBe(false);
  });

  it('escapes literal Next.js dynamic-route brackets', () => {
    const re = remainderToRegex('[id]/x.ts');
    expect(re.test('[id]/x.ts')).toBe(true);
    expect(re.test('a/x.ts')).toBe(false); // not treated as a char class
  });

  it('throws on brace alternation', () => {
    expect(() => remainderToRegex('{a,b}.ts')).toThrow(/brace alternation/);
  });

  it('throws on extglob', () => {
    expect(() => remainderToRegex('!(x).ts')).toThrow(/extglob/);
  });
});

describe('expandGlob / expandGlobs (real fs)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ts-glob-'));
    await mkdir(join(root, 'pkg', 'sub'), { recursive: true });
    await mkdir(join(root, 'pkg', 'node_modules'), { recursive: true });
    await writeFile(join(root, 'pkg', 'a.test.ts'), 'a');
    await writeFile(join(root, 'pkg', 'b.test.ts'), 'bb');
    await writeFile(join(root, 'pkg', 'sub', 'c.test.ts'), 'ccc');
    await writeFile(join(root, 'pkg', 'node_modules', 'skip.test.ts'), 'x');
    await writeFile(join(root, 'literal.txt'), 'hello');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('expands "*" to the immediate dir only', async () => {
    const hits = (await expandGlob(root, 'pkg/*.test.ts')).map((h) => h.path).sort();
    expect(hits).toEqual(['pkg/a.test.ts', 'pkg/b.test.ts']);
  });

  it('expands "**" recursively but skips ignored dirs (node_modules)', async () => {
    const hits = (await expandGlob(root, 'pkg/**/*.test.ts')).map((h) => h.path).sort();
    expect(hits).toEqual(['pkg/a.test.ts', 'pkg/b.test.ts', 'pkg/sub/c.test.ts']);
  });

  it('resolves a literal path to a single hit with size/mtime', async () => {
    const hits = await expandGlob(root, 'literal.txt');
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('literal.txt');
    expect(hits[0].sizeBytes).toBe(5);
    expect(typeof hits[0].mtimeMs).toBe('number');
  });

  it('returns [] for a missing literal or non-matching glob', async () => {
    expect(await expandGlob(root, 'nope.ts')).toEqual([]);
    expect(await expandGlob(root, 'pkg/*.spec.ts')).toEqual([]);
  });

  it('dedupes across patterns and sorts by path', async () => {
    const hits = await expandGlobs(root, ['pkg/**/*.test.ts', 'pkg/*.test.ts']);
    const paths = hits.map((h) => h.path);
    expect(paths).toEqual(['pkg/a.test.ts', 'pkg/b.test.ts', 'pkg/sub/c.test.ts']);
  });
});

describe('inferWorkspaceRoot', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ts-wsroot-'));
    await mkdir(join(root, 'ws', 'nested', 'deep'), { recursive: true });
    await writeFile(join(root, 'ws', 'pnpm-workspace.yaml'), 'packages: []');
    await mkdir(join(root, 'gitonly', 'inner'), { recursive: true });
    await mkdir(join(root, 'gitonly', '.git'), { recursive: true });
    // mixed/: an OUTER pnpm-workspace.yaml above an INNER .git — the
    // precedence case EI-18771273773696439 called out.
    await mkdir(join(root, 'mixed', 'inner', 'deep'), { recursive: true });
    await writeFile(join(root, 'mixed', 'pnpm-workspace.yaml'), 'packages: []');
    await mkdir(join(root, 'mixed', 'inner', '.git'), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    _resetWorkspaceRootCache();
  });

  it('finds the nearest ancestor with pnpm-workspace.yaml', () => {
    _resetWorkspaceRootCache();
    expect(inferWorkspaceRoot(join(root, 'ws', 'nested', 'deep'))).toBe(join(root, 'ws'));
  });

  it('falls back to the nearest .git ancestor', () => {
    _resetWorkspaceRootCache();
    expect(inferWorkspaceRoot(join(root, 'gitonly', 'inner'))).toBe(join(root, 'gitonly'));
  });

  it('takes the NEAREST marker — an outer pnpm-workspace.yaml does not outrank an inner .git', () => {
    // EI-18771273773696439: the old implementation walked for
    // pnpm-workspace.yaml all the way to `/` BEFORE ever looking for `.git`,
    // so the outer workspace marker won from any depth. Nearest wins now.
    _resetWorkspaceRootCache();
    expect(inferWorkspaceRoot(join(root, 'mixed', 'inner', 'deep'))).toBe(
      join(root, 'mixed', 'inner'),
    );
    // ...and a path under the outer dir but ABOVE the inner .git still
    // resolves to the workspace marker, so the marker itself still counts.
    _resetWorkspaceRootCache();
    expect(inferWorkspaceRoot(join(root, 'mixed'))).toBe(join(root, 'mixed'));
  });

  it('memoizes PER START PATH, never process-globally (EI-18771273773696439)', () => {
    _resetWorkspaceRootCache();
    const wsRoot = inferWorkspaceRoot(join(root, 'ws', 'nested'));
    expect(wsRoot).toBe(join(root, 'ws'));

    // THE REGRESSION THIS PINS: a different start path must RE-RESOLVE. The
    // old process-wide memo returned `wsRoot` here — which is exactly how one
    // shared operator process answered about the staging tree for a caller
    // rooted in the release checkout (and vice versa), handing agents a green
    // verdict about code they had not written.
    expect(inferWorkspaceRoot(join(root, 'gitonly', 'inner'))).toBe(join(root, 'gitonly'));
    expect(inferWorkspaceRoot(join(root, 'gitonly', 'inner'))).not.toBe(wsRoot);

    // The legitimate half of the old behaviour survives: the SAME start path
    // is still served from cache rather than re-walked.
    expect(inferWorkspaceRoot(join(root, 'ws', 'nested'))).toBe(wsRoot);
  });

  it('normalises the start path so equivalent spellings share one cache entry', () => {
    _resetWorkspaceRootCache();
    const direct = inferWorkspaceRoot(join(root, 'gitonly', 'inner'));
    const viaDotDot = inferWorkspaceRoot(join(root, 'gitonly', 'inner', 'deep', '..'));
    expect(viaDotDot).toBe(direct);
  });
});

describe('resolveNearestVitestConfig (EI-8902)', () => {
  // Two SEPARATE fixture roots — deliberately not shared — so the "no config
  // anywhere" case can't be contaminated by a root-level config added for the
  // "finds a root-level config" case.
  describe('a workspace with no root-level config (this repo’s actual shape, CLAUDE.md EI-7666)', () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'ts-vconfig-noroot-'));
      // apps/pkg-a has its own vitest.config.ts; a nested test file should find it.
      await mkdir(join(root, 'apps', 'pkg-a', 'src', 'deep'), { recursive: true });
      await writeFile(join(root, 'apps', 'pkg-a', 'vitest.config.ts'), 'export default {}');
      await writeFile(join(root, 'apps', 'pkg-a', 'src', 'deep', 'x.test.ts'), 'x');
      // apps/pkg-b has NO vitest.config.* anywhere in its chain up to root, and
      // root itself has none either.
      await mkdir(join(root, 'apps', 'pkg-b', 'src'), { recursive: true });
      await writeFile(join(root, 'apps', 'pkg-b', 'src', 'y.test.ts'), 'y');
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('finds a package-level config by walking up from a nested test file', () => {
      const found = resolveNearestVitestConfig('apps/pkg-a/src/deep/x.test.ts', root);
      expect(found).toBe(join(root, 'apps', 'pkg-a', 'vitest.config.ts'));
    });

    it('returns null when no config exists anywhere up to the workspace root (the EI-8902 bare-invocation case)', () => {
      const found = resolveNearestVitestConfig('apps/pkg-b/src/y.test.ts', root);
      expect(found).toBeNull();
    });

    it('never walks above workspaceRoot even if an ancestor outside it has a config', () => {
      // pkg-b's chain (apps/pkg-b -> apps -> root) is checked; nothing above
      // root is ever consulted — pin the stop condition by narrowing
      // workspaceRoot itself to 'apps' (one level below the real root).
      const found = resolveNearestVitestConfig('apps/pkg-b/src/y.test.ts', join(root, 'apps'));
      expect(found).toBeNull();
    });
  });

  describe('a workspace WITH a root-level config', () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'ts-vconfig-withroot-'));
      await mkdir(join(root, 'apps', 'pkg-c'), { recursive: true });
      await writeFile(join(root, 'vitest.config.mjs'), 'export default {}');
      await writeFile(join(root, 'apps', 'pkg-c', 'z.test.ts'), 'z');
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('finds the root-level config when the nearest package has none of its own', () => {
      const found = resolveNearestVitestConfig('apps/pkg-c/z.test.ts', root);
      expect(found).toBe(join(root, 'vitest.config.mjs'));
    });
  });
});
