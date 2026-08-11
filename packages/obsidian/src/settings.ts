export interface PlaudSettings {
  /**
   * @deprecated Region now comes from the CLI-managed ~/.plaud/config.json
   * (single source of truth) and auto-corrects on mismatch. Kept optional so
   * existing plugin data.json still loads; no longer read.
   */
  plaudRegion?: 'us' | 'eu';
  /**
   * When Plaud has no server transcript, transcribe locally with
   * `macparakeet-cli` (Parakeet TDT). Exact speaker count for diarization
   * (0/undefined → let macparakeet auto-detect).
   */
  parakeetSpeakerCount?: number;
  /**
   * Generate an AI summary for locally-transcribed recordings via macparakeet's
   * prompt library (`prompts run`). Off by default — it calls an LLM provider.
   */
  parakeetSummaryEnabled: boolean;
  /** macparakeet prompt name to run for the summary (e.g. "Summary"). */
  parakeetSummaryPrompt: string;
  /**
   * macparakeet summary provider. Default "cli" runs a local command (Claude
   * Code) with no API key; "anthropic" etc. use a hosted key.
   */
  parakeetSummaryProvider: string;
  /** Command for the "cli" provider (default "claude -p"). */
  parakeetSummaryCommand: string;
  /** Model id for hosted providers (ignored by the cli provider). */
  parakeetSummaryModel: string;
  /**
   * Single shared vault folder that holds each recording's files, keyed by a
   * shared `<date>_<slug>` stem: `<stem>.md` note, `<stem>.<ext>` audio,
   * `<stem>.json` transcript, `<stem>.summary.md` AI summary.
   */
  triadFolder: string;
  /**
   * @deprecated Superwhisper is no longer used; local transcription is
   * macparakeet. Kept optional so existing data.json still loads.
   */
  superwhisperRecordingsPath?: string;
  /** @deprecated Superwhisper timeout — no longer used. */
  superwhisperTimeoutMinutes?: number;
  /** @deprecated legacy mlx_whisper path. */
  pythonPath?: string;
  /** @deprecated legacy whisper model. */
  whisperModel?: string;
  /** @deprecated legacy whisper language. */
  whisperLanguage?: string;
  audioFolder: string;
  notesFolder: string;
  syncIntervalMinutes: number;
  noteTemplate: string;
  syncedIds: string[];
}

export const DEFAULT_SETTINGS: PlaudSettings = {
  parakeetSummaryEnabled: false,
  parakeetSummaryPrompt: 'Summary',
  parakeetSummaryProvider: 'cli',
  parakeetSummaryCommand: 'claude -p',
  parakeetSummaryModel: 'claude-sonnet-5',
  triadFolder: '__Support/Plaud',
  audioFolder: 'Plaud/Audio',
  notesFolder: 'Plaud/Notes',
  syncIntervalMinutes: 60,
  noteTemplate: `---
plaud_id: {{id}}
title: "{{title}}"
date: "{{date}}"
time: {{time}}
duration: "{{duration}}"
source: plaud_pin
audio: "[[{{audio_path}}]]"
tags: [voice-note, transcription]
---

# {{title}}

## Transcript

{{transcript}}

## Timestamps

{{timestamps}}
`,
  syncedIds: [],
};
