import { recordingStem } from '@plaud/core';
import type { PlaudFile } from '../types';
import type { PlaudSettings } from '../settings';

/**
 * A recording's "triad" lives as files sharing one stem in a single flat folder
 * (`settings.triadFolder`):
 *
 *   <stem>.md          transcript note
 *   <stem>.<ext>       audio (e.g. mp3)
 *   <stem>.json        transcript (speaker-labelled segments; Plaud or macparakeet)
 *   <stem>.summary.md  AI summary (Plaud's, or macparakeet + LLM) — only when present
 *
 * The stem is the shared `recordingStem` from @plaud/core, so the Obsidian
 * plugin and the CLI produce identical filenames for the same recording (no
 * duplicate file sets).
 */

/** The folder that holds all triads. */
export function triadFolder(settings: PlaudSettings): string {
  const f = (settings.triadFolder ?? '').trim();
  return f || '__Support/Plaud';
}

/** Shared, readable stem (`<date>_<slug>`) — identical to the CLI's. */
export function triadStem(rec: PlaudFile): string {
  return recordingStem(rec);
}

/** `<triadFolder>/<ts>.md` — the transcript note path. */
export function triadNotePath(rec: PlaudFile, settings: PlaudSettings): string {
  return `${triadFolder(settings)}/${triadStem(rec)}.md`;
}

/** `<triadFolder>/<ts>.<ext>` — the audio path. `ext` has no leading dot. */
export function triadAudioPath(
  rec: PlaudFile,
  settings: PlaudSettings,
  ext: string,
): string {
  const clean = (ext || 'mp3').replace(/^\./, '');
  return `${triadFolder(settings)}/${triadStem(rec)}.${clean}`;
}

/**
 * `<triadFolder>/<ts>.json` — the Plaud transcript stored as structured JSON
 * (segments array with speaker labels), written when a server transcript exists.
 */
export function triadTranscriptJsonPath(rec: PlaudFile, settings: PlaudSettings): string {
  return `${triadFolder(settings)}/${triadStem(rec)}.json`;
}

/**
 * `<triadFolder>/<ts>.summary.md` — Plaud's AI summary as markdown, written only
 * when the recording has a server-side summary.
 */
export function triadSummaryPath(rec: PlaudFile, settings: PlaudSettings): string {
  return `${triadFolder(settings)}/${triadStem(rec)}.summary.md`;
}
