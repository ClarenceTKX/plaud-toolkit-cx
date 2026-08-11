import { Notice } from 'obsidian';
import { basename } from 'path';
import { ParakeetBridge, type ParakeetTranscription, type ParakeetPrompt } from '@plaud/core';
import type { PlaudSettings } from '../settings';
import type { TranscriptionResult } from '../types';

export type { ParakeetTranscription } from '@plaud/core';

/**
 * Obsidian adapter around the shared macparakeet bridge in `@plaud/core`.
 *
 * The core bridge shells out to `macparakeet-cli` (local Parakeet TDT, no paste,
 * synchronous); this wrapper adds the in-app `Notice` UI. It exposes both the
 * rich macparakeet result (with the history id needed for summaries) and a
 * plain `TranscriptionResult` view. Kept named `WhisperBridge` so call sites are
 * unchanged.
 */
export class WhisperBridge {
  private core = new ParakeetBridge();

  /** Full macparakeet result (id + speaker segments), for callers that summarize. */
  async transcribeRich(
    audioAbsPath: string,
    settings: PlaudSettings,
  ): Promise<ParakeetTranscription> {
    const notice = new Notice(
      `Plaud: transcribing ${basename(audioAbsPath)} with macparakeet…`,
      0,
    );
    try {
      return await this.core.transcribe(audioAbsPath, {
        keepHistory: true, // keep history so summaries can reference the id
        speakerCount: settings.parakeetSpeakerCount,
      });
    } finally {
      notice.hide();
    }
  }

  /** Backwards-compatible plain transcription. */
  async transcribe(
    audioAbsPath: string,
    settings: PlaudSettings,
  ): Promise<TranscriptionResult> {
    return toTranscriptionResult(await this.transcribeRich(audioAbsPath, settings));
  }

  /**
   * Run a macparakeet summary prompt against a transcription id. Defaults to the
   * local `cli` provider (Claude Code, `claude -p`) — no API key needed.
   */
  async summarize(transcriptionId: string, settings: PlaudSettings, promptName?: string): Promise<string> {
    return this.core.summarize(transcriptionId, {
      promptName: promptName ?? settings.parakeetSummaryPrompt,
      provider: settings.parakeetSummaryProvider || 'cli',
      command: settings.parakeetSummaryCommand || 'claude -p',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      model: settings.parakeetSummaryModel,
    });
  }

  /** List macparakeet's saved summary prompts (for the Summarise picker). */
  async listPrompts(): Promise<ParakeetPrompt[]> {
    return this.core.listPrompts();
  }

  /** Transcribe just to obtain a macparakeet history id (for on-demand summary). */
  async transcribeForId(audioAbsPath: string, settings: PlaudSettings): Promise<string> {
    const r = await this.core.transcribe(audioAbsPath, {
      keepHistory: true,
      speakerCount: settings.parakeetSpeakerCount,
    });
    return r.id;
  }

  /** Check that macparakeet-cli is installed and its models are ready. */
  async checkInstallation(_settings: PlaudSettings): Promise<string | null> {
    const h = await this.core.health();
    return h.ok ? null : (h.reason ?? 'macparakeet-cli not ready');
  }
}

export function toTranscriptionResult(t: ParakeetTranscription): TranscriptionResult {
  return {
    text: t.text,
    segments: t.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
    language: t.language,
  };
}
