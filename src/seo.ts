/**
 * Claude SEO — shared, React-free, Node-free types + pure helpers. Imported by
 * the server runner (`server/claude-seo.ts`), the web panel (`web/ClaudeSeoPanel.tsx`),
 * and the consumer's store. Keep free of `fetch`/`node:*`/React (mirrors `pagespeed.ts`).
 */

/** URL-taking `/seo <command> <url>` commands exposed in the panel picker. */
export const SEO_COMMANDS = [
  'page',
  'audit',
  'technical',
  'content',
  'schema',
  'geo',
  'images',
  'local',
  'ecommerce',
  'hreflang',
  'sxo',
  'backlinks',
] as const;
export type SeoCommand = (typeof SEO_COMMANDS)[number];

/** Human labels + a "heavy" flag (fans out many subagents → minutes + most tokens). */
export const SEO_COMMAND_META: Record<SeoCommand, { label: string; heavy?: boolean }> = {
  page: { label: 'Page (single-page deep dive)' },
  audit: { label: 'Audit (full site — heavy)', heavy: true },
  technical: { label: 'Technical (9 categories)' },
  content: { label: 'Content / E-E-A-T' },
  schema: { label: 'Schema.org markup' },
  geo: { label: 'GEO (AI search)' },
  images: { label: 'Images' },
  local: { label: 'Local SEO' },
  ecommerce: { label: 'E-commerce' },
  hreflang: { label: 'Hreflang / i18n' },
  sxo: { label: 'Search Experience (SXO)' },
  backlinks: { label: 'Backlinks' },
};

/** A persisted Claude SEO report (the store adds id/project/createdAt). */
export interface SeoReport {
  id: string;
  project: string | null;
  url: string;
  command: string;
  score: number | null;
  report: string; // markdown action plan
  createdAt: string; // ISO
}

/**
 * Pull the 0–100 score out of a claude-seo report markdown. The skill emits a
 * scorecard like `Overall Score: 28/100`; fall back to the first `NN/100`.
 */
export function parseSeoScore(reportMarkdown: string): number | null {
  if (!reportMarkdown) return null;
  const m =
    reportMarkdown.match(/(?:overall|seo)\s+score\s*[:=]?\s*(\d{1,3})\s*\/\s*100/i) ??
    reportMarkdown.match(/\b(\d{1,3})\s*\/\s*100\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
