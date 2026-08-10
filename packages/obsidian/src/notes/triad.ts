import type { PlaudFile } from '../types';
import type { PlaudSettings } from '../settings';

/**
 * A recording's "triad" lives as three files sharing one timestamp stem in a
 * single flat folder (`settings.triadFolder`):
 *
 *   <ts>.md        transcript note
 *   <ts>.<ext>     audio passed to Superwhisper (e.g. mp3/wav)
 *   <ts>.llm.md    AI result — written only when Superwhisper produced one
 *
 * Keying by a stable per-recording timestamp keeps the three grouped together
 * and guarantees uniqueness without per-recording subfolders.
 */

/** The folder that holds all triads. */
export function triadFolder(settings: PlaudSettings): string {
  const f = (settings.triadFolder ?? '').trim();
  return f || '__Support/Plaud';
}

/**
 * Stable, unique stem for a recording's triad files. Uses the recording's
 * start time as epoch-milliseconds (Superwhisper itself names folders this way),
 * falling back to the recording id if the timestamp is unusable.
 */
export function triadStem(rec: PlaudFile): string {
  const ms = Number(rec.start_time);
  if (Number.isFinite(ms) && ms > 0) {
    return String(Math.floor(ms));
  }
  // Fallback: sanitize the id so it's filename-safe.
  return String(rec.id).replace(/[^\w-]/g, '_');
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

/** `<triadFolder>/<ts>.llm.md` — the AI-result path (only written when present). */
export function triadLlmPath(rec: PlaudFile, settings: PlaudSettings): string {
  return `${triadFolder(settings)}/${triadStem(rec)}.llm.md`;
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
