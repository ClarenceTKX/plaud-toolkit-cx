export interface PlaudSettings {
  /**
   * @deprecated Region now comes from the CLI-managed ~/.plaud/config.json
   * (single source of truth) and auto-corrects on mismatch. Kept optional so
   * existing plugin data.json still loads; no longer read.
   */
  plaudRegion?: 'us' | 'eu';
  /**
   * Absolute path to Superwhisper's recordings folder. Superwhisper writes one
   * timestamped subfolder per transcription, each containing a `meta.json`.
   * Empty means auto-detect (~/superwhisper/recordings, then the legacy
   * ~/Documents/superwhisper/recordings).
   */
  superwhisperRecordingsPath: string;
  /** Max minutes to wait for Superwhisper to finish a transcription. */
  superwhisperTimeoutMinutes: number;
  /**
   * Single shared vault folder that holds each recording's "triad": the
   * transcript note (`<ts>.md`), the audio passed to Superwhisper (`<ts>.<ext>`),
   * and — only when Superwhisper produced one — the AI result (`<ts>.llm.md`).
   * Files are keyed by a per-recording timestamp stem so the three group
   * together in one flat folder.
   */
  triadFolder: string;
  /**
   * @deprecated Superwhisper is driven by its active *mode*, not CLI flags.
   * Retained so existing user data loads without loss; no longer used by the
   * transcription bridge.
   */
  pythonPath?: string;
  /** @deprecated See `pythonPath`. Mode selection now controls the model. */
  whisperModel?: string;
  /** @deprecated See `pythonPath`. Language is governed by the active mode. */
  whisperLanguage?: string;
  audioFolder: string;
  notesFolder: string;
  syncIntervalMinutes: number;
  noteTemplate: string;
  syncedIds: string[];
}

export const DEFAULT_SETTINGS: PlaudSettings = {
  superwhisperRecordingsPath: '',
  superwhisperTimeoutMinutes: 10,
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
