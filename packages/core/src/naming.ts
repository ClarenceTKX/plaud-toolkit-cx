import type { PlaudRecording } from './types.js';

/**
 * The single source of truth for a recording's filename stem, shared by the CLI
 * and the Obsidian plugin so they can never diverge and produce duplicate file
 * sets for the same recording.
 *
 * Scheme: `<YYYY-MM-DD>_<slug>` where the date comes from the recording's
 * start/created time and the slug is a filesystem-safe, length-capped version of
 * its name (falling back to the id). Example:
 *   2026-07-16_07_16_Meeting_Hands_Free_AI_Assistant
 */
export function recordingStem(rec: Pick<PlaudRecording, 'id' | 'name' | 'start_at' | 'created_at'>): string {
  const iso = (rec.start_at ?? rec.created_at ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'unknown';
  const slug = slugify(rec.name) || sanitizeId(rec.id);
  return `${date}_${slug}`;
}

/** Filesystem-safe slug: alphanumerics kept, runs of other chars → `_`, capped. */
export function slugify(name: string | undefined): string {
  return String(name ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/g, '');
}

function sanitizeId(id: string): string {
  return String(id).replace(/[^\w-]/g, '_');
}
