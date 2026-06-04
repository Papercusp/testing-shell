/**
 * Claude SEO backend core — spawns a HEADLESS Claude Code (`claude -p "/seo <cmd> <url>"`)
 * with the claude-seo skill pack installed in an isolated HOME, and relays its
 * stream-json events as SSE frames (log/report/done/error). Framework-agnostic
 * (no React/Hono/DB). Mirrors `ai-explore` (spawn an LLM-agent child + stream).
 *
 * claude-seo (github.com/AgriciDaniel/claude-seo) is a Claude Code plugin, not an
 * API — "running it" means spawning Claude Code. The consumer provides `homeDir`
 * (an isolated HOME holding the plugin + a symlinked login) so this never touches
 * the shared ~/.claude.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { isPubliclyFetchable } from './google-pagespeed';
import { parseSeoScore, SEO_COMMANDS, type SeoCommand, type SeoReport } from '../seo';

export type { SeoReport, SeoCommand } from '../seo';
export { SEO_COMMANDS, SEO_COMMAND_META, parseSeoScore } from '../seo';

export interface ClaudeSeoConfig {
  command: SeoCommand;
  url: string;
}

/** Storage seam — Restart supplies a Postgres impl (same shape as PageSpeedStore). */
export interface ClaudeSeoStore {
  save(r: { url: string; command: string; score: number | null; report: string }, meta: { project?: string | null }): Promise<SeoReport>;
  list(opts: { project?: string | null; url?: string; command?: string; limit: number }): Promise<SeoReport[]>;
  get(id: string): Promise<SeoReport | null>;
  listUrls(opts: { project?: string | null; limit: number }): Promise<{ url: string; count: number; lastRunAt: string }[]>;
}

/** Validate + normalize the request body. Pure. */
export function parseClaudeSeoConfig(
  body: unknown,
  opts: { defaultUrl?: string; defaultCommand?: SeoCommand } = {},
): { ok: true; cfg: ClaudeSeoConfig } | { ok: false; msg: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawCmd = (typeof b.command === 'string' ? b.command : (opts.defaultCommand ?? 'page')).toLowerCase().trim();
  if (!(SEO_COMMANDS as readonly string[]).includes(rawCmd)) {
    return { ok: false, msg: `command must be one of: ${SEO_COMMANDS.join(', ')}` };
  }
  const rawUrl = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : opts.defaultUrl;
  if (!rawUrl) return { ok: false, msg: 'url is required' };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, msg: `invalid url: ${rawUrl}` };
  }
  if (!isPubliclyFetchable(url)) {
    return { ok: false, msg: `Claude SEO fetches the URL — it must be public (not localhost). e.g. https://shop.buyrestart.com` };
  }
  return { ok: true, cfg: { command: rawCmd as SeoCommand, url: url.toString() } };
}

export interface ClaudeSeoRunOpts {
  /** Isolated HOME holding the claude-seo plugin (~/.claude/skills+agents) + a symlinked login. */
  homeDir: string;
  claudeBin?: string;
  /** Scratch working dir for the child (not the repo). Defaults to homeDir. */
  cwd?: string;
  /** Injectable for tests. */
  spawnImpl?: typeof nodeSpawn;
  /** Kill the run after this many ms (best-effort). */
  timeoutMs?: number;
}

const enc = new TextEncoder();
function sseFrame(type: string, payload: Record<string, unknown>): Uint8Array {
  return enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Text + tool-use indicators from a stream-json `assistant` event's content[]. */
function assistantLines(msg: unknown): string[] {
  const content = (msg as { content?: unknown[] })?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push(c.text);
    else if (c?.type === 'tool_use' && typeof c.name === 'string') out.push(`→ ${c.name}`);
  }
  return out;
}

/**
 * Spawn the headless claude-seo run and return an SSE body stream:
 *   event: log    data: {line}              — live assistant text + tool calls
 *   event: report data: {report}            — the final markdown report (once)
 *   event: done   data: {isError,score,costUsd,exitCode}
 *   event: error  data: {message}
 */
export function spawnClaudeSeoStream(cfg: ClaudeSeoConfig, opts: ClaudeSeoRunOpts): ReadableStream<Uint8Array> {
  const spawn = opts.spawnImpl ?? nodeSpawn;
  const bin = opts.claudeBin ?? 'claude';
  const args = [
    '-p',
    `/seo ${cfg.command} ${cfg.url}`,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          cwd: opts.cwd ?? opts.homeDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, HOME: opts.homeDir, NODE_OPTIONS: '' },
        });
      } catch (e) {
        controller.enqueue(sseFrame('error', { message: `failed to spawn ${bin}: ${String(e)}` }));
        controller.close();
        return;
      }

      let report: string | null = null;
      let accumulated = '';
      let done = false;
      const enqueue = (f: Uint8Array) => {
        try {
          controller.enqueue(f);
        } catch {
          /* stream closed */
        }
      };
      const finish = (extra: Record<string, unknown>) => {
        if (done) return;
        done = true;
        const body = report ?? accumulated.trim();
        if (body) enqueue(sseFrame('report', { report: body }));
        enqueue(sseFrame('done', { score: parseSeoScore(body), ...extra }));
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            try {
              child.kill('SIGTERM');
            } catch {
              /* dead */
            }
            finish({ isError: true, exitCode: -1, timedOut: true });
          }, opts.timeoutMs)
        : null;

      let outBuf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        outBuf += chunk.toString();
        const lines = outBuf.split('\n');
        outBuf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let o: Record<string, unknown>;
          try {
            o = JSON.parse(t);
          } catch {
            continue;
          }
          if (o.type === 'assistant') {
            for (const l of assistantLines(o.message)) {
              accumulated += (accumulated ? '\n' : '') + l;
              enqueue(sseFrame('log', { line: l.slice(0, 2000) }));
            }
          } else if (o.type === 'result') {
            if (typeof o.result === 'string') report = o.result;
            if (timer) clearTimeout(timer);
            finish({ isError: Boolean(o.is_error), exitCode: 0, costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null });
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const t = chunk.toString().trim();
        if (t) enqueue(sseFrame('log', { level: 'error', line: t.slice(0, 2000) }));
      });
      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        enqueue(sseFrame('error', { message: String(err?.message ?? err) }));
        finish({ isError: true, exitCode: -1 });
      });
      child.on('exit', (code: number | null) => {
        if (timer) clearTimeout(timer);
        finish({ isError: code !== 0 && report === null, exitCode: code ?? -1 });
      });
    },
  });
}
