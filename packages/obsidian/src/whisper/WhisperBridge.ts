import { Notice } from 'obsidian';
import { basename } from 'path';
import {
  SuperwhisperBridge as CoreSuperwhisper,
  type SuperwhisperTranscription,
} from '@plaud/core';
import type { PlaudSettings } from '../settings';

export type { SuperwhisperTranscription, SuperwhisperMetaInfo } from '@plaud/core';

/**
 * Obsidian adapter around the shared Superwhisper bridge in `@plaud/core`.
 *
 * The core bridge does the launch/watch/parse work (no Obsidian dependency);
 * this wrapper maps `PlaudSettings` onto the core options and adds the in-app
 * `Notice` progress UI. The class keeps the name `WhisperBridge` and the
 * `transcribe(path, settings)` signature so existing call sites are unchanged.
 */
export class WhisperBridge {
  private core = new CoreSuperwhisper();

  async transcribe(
    audioAbsPath: string,
    settings: PlaudSettings,
  ): Promise<SuperwhisperTranscription> {
    const notice = new Notice(
      `Plaud: transcribing ${basename(audioAbsPath)} with Superwhisper…`,
      0,
    );
    try {
      return await this.core.transcribe(audioAbsPath, {
        recordingsPath: settings.superwhisperRecordingsPath,
        timeoutMinutes: settings.superwhisperTimeoutMinutes,
        onProgress: (ready, expected) => {
          notice.setMessage(
            `Plaud: transcribing ${basename(audioAbsPath)} with Superwhisper… (${ready}/${expected} done)`,
          );
        },
      });
    } finally {
      notice.hide();
    }
  }

  /** Check that Superwhisper is installed and its recordings folder exists. */
  async checkInstallation(settings: PlaudSettings): Promise<string | null> {
    return this.core.checkInstallation(settings.superwhisperRecordingsPath);
  }
}
