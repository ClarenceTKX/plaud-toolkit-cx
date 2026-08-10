import type { TranscriptionResult, WhisperSegment } from '../types';

/**
 * Pure parsing of a Superwhisper `meta.json` payload — no Obsidian or Node
 * runtime dependencies, so it can be unit-tested directly against real fixtures.
 * The bridge (`WhisperBridge.ts`) reads the file and delegates the interpretation
 * here.
 *
 * Field names/optionality verified against a real Superwhisper 2.17.2 export
 * (Parakeet voice model, voice-only "Default" mode — no `llmResult` present).
 */

/** One entry of Superwhisper's `segments` array. */
export interface SuperwhisperSegment {
  text?: string;
  start?: number;
  end?: number;
}

/** The subset of `meta.json` fields the bridge relies on. */
export interface SuperwhisperMeta {
  /** Voice-to-text transcript with Superwhisper's own cleanup applied. */
  result?: string;
  /**
   * AI-processed / formatted text — only present when the active mode ran an
   * LLM. Absent (not just empty) for voice-only modes.
   */
  llmResult?: string;
  /** Unformatted transcript before Superwhisper's cleanup (has filler words). */
  rawResult?: string;
  /** Per-segment breakdown: `{ text, start, end }` (seconds). */
  segments?: SuperwhisperSegment[];
  /** ISO-ish local timestamp, e.g. "2026-08-08T07:40:40". */
  datetime?: string;
  /** Recording length in **milliseconds**. */
  duration?: number;
  /** Voice model identifier, e.g. "nvidia_parakeet-v3_494MB". */
  modelKey?: string;
  /** Human-readable voice model name, e.g. "Parakeet Multilanguage". */
  modelName?: string;
  /** Language of the transcription result, e.g. "en". */
  languageSelected?: string;
  /** LLM model key/name — populated only when an AI mode ran. */
  languageModelKey?: string;
  languageModelName?: string;
  /** Nested context; `promptContext.systemContext.language` also carries language. */
  promptContext?: {
    systemContext?: { language?: string };
    modeContext?: { language?: string; type?: string };
  };
  /** Mode used, e.g. "Default". */
  modeName?: string;
}

/** Extra Superwhisper metadata surfaced for the note-writing layer. */
export interface SuperwhisperMetaInfo {
  modelName?: string;
  modeName?: string;
  /** Recording duration in seconds (converted from meta's milliseconds). */
  durationSeconds?: number;
  datetime?: string;
}

/**
 * Result of one transcription, extended with Superwhisper-specific provenance
 * so the note-writing layer can decide whether AI processing is still needed.
 */
export interface SuperwhisperTranscription extends TranscriptionResult {
  /** True when the transcript came from `llmResult`; false when it fell back to `result`. */
  llmProcessed: boolean;
  /** Absolute path of the recording folder the result was read from. */
  recordingFolder?: string;
  /** Extra provenance from meta.json (model, mode, duration, datetime). */
  meta?: SuperwhisperMetaInfo;
}

/**
 * Interpret a parsed `meta.json` object into a `SuperwhisperTranscription`.
 * Prefers `llmResult`; falls back to the raw voice `result` (then `rawResult`).
 */
export function transcriptionFromMeta(
  meta: SuperwhisperMeta,
  recordingFolder?: string,
): SuperwhisperTranscription {
  const llm = (meta.llmResult ?? '').trim();
  const voice = (meta.result ?? meta.rawResult ?? '').trim();

  // `llmResult` is absent (not empty) in voice-only modes, so presence of a
  // non-empty value is the correct signal for "AI processing happened".
  const llmProcessed = llm.length > 0;
  const text = llmProcessed ? llm : voice;

  const language =
    meta.languageSelected ||
    meta.promptContext?.systemContext?.language ||
    meta.promptContext?.modeContext?.language ||
    undefined;

  return {
    text,
    segments: mapSegments(meta.segments),
    language,
    llmProcessed,
    recordingFolder,
    meta: {
      modelName: meta.modelName || meta.modelKey || undefined,
      modeName: meta.modeName || undefined,
      durationSeconds:
        typeof meta.duration === 'number' ? meta.duration / 1000 : undefined,
      datetime: meta.datetime || undefined,
    },
  };
}

/**
 * Map Superwhisper segments into the plugin's `{ start, end, text }` shape.
 * Verified format is `{ text, start, end }` (start/end in seconds). Entries
 * without usable text are skipped; leading spaces in `text` are trimmed.
 */
export function mapSegments(
  segments: SuperwhisperSegment[] | undefined,
): WhisperSegment[] {
  if (!Array.isArray(segments)) return [];
  const out: WhisperSegment[] = [];
  for (const s of segments) {
    if (s == null || typeof s !== 'object') continue;
    const text = String(s.text ?? '').trim();
    if (!text) continue;
    out.push({
      start: Number(s.start ?? 0) || 0,
      end: Number(s.end ?? 0) || 0,
      text,
    });
  }
  return out;
}
