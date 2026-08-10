import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { Notice } from 'obsidian';
import type { PlaudSettings } from '../settings';
import {
  transcriptionFromMeta,
  type SuperwhisperMeta,
  type SuperwhisperTranscription,
} from './parseMeta';

export type { SuperwhisperTranscription, SuperwhisperMetaInfo } from './parseMeta';

const execFileAsync = promisify(execFile);

/** How long to wait for Superwhisper to finish writing a result before giving up. */
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
/** How often to poll the recordings folder for new results. */
const POLL_INTERVAL_MS = 1_000;
/** Filename Superwhisper writes into each recording folder when a result is ready. */
const META_FILENAME = 'meta.json';

/**
 * Bridge to Superwhisper's on-device transcription.
 *
 * Unlike the previous mlx_whisper bridge (a blocking CLI that wrote a
 * deterministic JSON path), Superwhisper is fire-and-forget: we hand it a file
 * with `open -a superwhisper`, it transcribes in the background using the
 * currently active *mode*, and drops the result into a new timestamped folder
 * under the recordings directory (default `~/superwhisper/recordings`). This
 * bridge launches transcription and then observes that folder for the freshly
 * written `meta.json`.
 *
 * The class keeps the name `WhisperBridge` (see alias at the bottom) so existing
 * call sites — `plugin.whisperBridge.transcribe(...)` — remain unchanged.
 */
export class SuperwhisperBridge {
  /**
   * Transcribe a single audio file with Superwhisper.
   *
   * Launches Superwhisper on the file, then waits for exactly one new result
   * folder (a `meta.json`) to appear whose modification time is newer than the
   * moment we triggered. Prefers `llmResult`, falling back to the raw `result`.
   */
  async transcribe(
    audioAbsPath: string,
    settings: PlaudSettings,
  ): Promise<SuperwhisperTranscription> {
    const results = await this.transcribeBatch([audioAbsPath], settings);
    return results[0];
  }

  /**
   * Transcribe several files, waiting until the same number of new result
   * folders have appeared before returning. This satisfies the batch guarantee:
   * if N files were submitted, resolve only once N json/wav pairs exist.
   *
   * Results are returned in the same order as `audioAbsPaths` by matching each
   * result folder back to its source audio filename. Any result whose source
   * can't be matched is assigned in folder-modification-time order as a
   * fallback, so a batch never silently loses an entry.
   */
  async transcribeBatch(
    audioAbsPaths: string[],
    settings: PlaudSettings,
  ): Promise<SuperwhisperTranscription[]> {
    if (audioAbsPaths.length === 0) return [];

    const recordingsDir = this.recordingsDir(settings);
    if (!existsSync(recordingsDir)) {
      throw new Error(
        `Superwhisper recordings folder not found at "${recordingsDir}". ` +
          `Set the correct path in Plaud settings, and make sure Superwhisper is installed and has run at least once.`,
      );
    }

    // Snapshot existing result folders so we only pick up ones created *after*
    // we trigger transcription.
    const triggerTime = Date.now();
    const seenBefore = new Set(this.listResultFolders(recordingsDir));

    const label =
      audioAbsPaths.length === 1
        ? basename(audioAbsPaths[0])
        : `${audioAbsPaths.length} files`;
    const statusNotice = new Notice(
      `Plaud: transcribing ${label} with Superwhisper…`,
      0,
    );

    try {
      // Launch Superwhisper on each file. `open -a` returns immediately;
      // Superwhisper processes in the background.
      for (const audioPath of audioAbsPaths) {
        if (!existsSync(audioPath)) {
          throw new Error(`Audio file not found: ${audioPath}`);
        }
        await this.launchSuperwhisper(audioPath, settings);
      }

      const expected = audioAbsPaths.length;
      const timeoutMs = this.timeoutMs(settings);

      // Poll until `expected` brand-new result folders each have a completed
      // meta.json, or we time out.
      const newFolders = await this.awaitResultFolders(
        recordingsDir,
        seenBefore,
        triggerTime,
        expected,
        timeoutMs,
        (ready) => {
          statusNotice.setMessage(
            `Plaud: transcribing ${label} with Superwhisper… (${ready}/${expected} done)`,
          );
        },
      );

      // Parse each new folder's meta.json.
      const parsed = newFolders.map((folder) => ({
        folder,
        result: this.parseMeta(folder),
      }));

      // Re-order results to line up with the input list where possible.
      return this.alignResults(audioAbsPaths, parsed);
    } finally {
      statusNotice.hide();
    }
  }

  /**
   * Launch Superwhisper against a file via `open <file> -a superwhisper`,
   * mirroring the documented command-line transcription entry point.
   */
  private async launchSuperwhisper(
    audioAbsPath: string,
    _settings: PlaudSettings,
  ): Promise<void> {
    const env = {
      ...process.env,
      HOME: homedir(),
      PATH: `/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
    };
    try {
      // `open` exits as soon as it has handed the file to the app.
      await execFileAsync('open', [audioAbsPath, '-a', 'superwhisper'], {
        timeout: 30_000,
        env,
      });
    } catch (err: any) {
      const stderr = err.stderr ?? '';
      throw new Error(
        `Failed to launch Superwhisper for "${basename(audioAbsPath)}": ${err.message ?? err}` +
          (stderr ? `\nstderr: ${stderr}` : ''),
      );
    }
  }

  /**
   * Poll the recordings directory until `expected` folders that did not exist
   * at trigger time each contain a `meta.json` modified after the trigger.
   * Returns those folders sorted by meta.json modification time (oldest first,
   * i.e. submission order).
   */
  private async awaitResultFolders(
    recordingsDir: string,
    seenBefore: Set<string>,
    triggerTime: number,
    expected: number,
    timeoutMs: number,
    onProgress?: (ready: number) => void,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let lastReadyCount = -1;

    while (Date.now() < deadline) {
      const ready: { folder: string; mtime: number }[] = [];

      for (const folder of this.listResultFolders(recordingsDir)) {
        if (seenBefore.has(folder)) continue;
        const metaPath = join(folder, META_FILENAME);
        if (!existsSync(metaPath)) continue; // folder created but result not written yet
        let mtime: number;
        try {
          mtime = statSync(metaPath).mtimeMs;
        } catch {
          continue;
        }
        // Guard against a stale meta.json in a reused folder name.
        if (mtime < triggerTime) continue;
        ready.push({ folder, mtime });
      }

      if (onProgress && ready.length !== lastReadyCount) {
        onProgress(ready.length);
        lastReadyCount = ready.length;
      }

      if (ready.length >= expected) {
        return ready
          .sort((a, b) => a.mtime - b.mtime)
          .slice(0, expected)
          .map((r) => r.folder);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Superwhisper transcription timed out after ${Math.round(timeoutMs / 1000)}s ` +
        `(waiting for ${expected} result(s)). Check that Superwhisper is running and a valid mode is active.`,
    );
  }

  /** Read and parse a Superwhisper recording folder's `meta.json`. */
  private parseMeta(folder: string): SuperwhisperTranscription {
    const metaPath = join(folder, META_FILENAME);
    let meta: SuperwhisperMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as SuperwhisperMeta;
    } catch (err) {
      throw new Error(`Failed to parse Superwhisper meta.json at ${metaPath}: ${err}`);
    }
    // Pure interpretation lives in parseMeta.ts so it can be unit-tested without
    // the Obsidian/Node runtime.
    return transcriptionFromMeta(meta, folder);
  }

  /**
   * Match parsed result folders back to their source audio files.
   *
   * Superwhisper folders are keyed by timestamp, not source filename, so a
   * reliable name match isn't always possible. We try to match by the audio
   * file basename appearing in the folder; whatever is left is filled in
   * submission (mtime) order so the returned array always has one entry per
   * input, in input order.
   */
  private alignResults(
    audioAbsPaths: string[],
    parsed: { folder: string; result: SuperwhisperTranscription }[],
  ): SuperwhisperTranscription[] {
    if (audioAbsPaths.length === 1) {
      return parsed.map((p) => p.result);
    }

    const remaining = [...parsed];
    const output: (SuperwhisperTranscription | undefined)[] = new Array(
      audioAbsPaths.length,
    ).fill(undefined);

    // First pass: match by source audio filename present in the folder.
    audioAbsPaths.forEach((audioPath, i) => {
      const stem = basename(audioPath).toLowerCase();
      const stemNoExt = stem.replace(/\.[^.]+$/, '');
      const idx = remaining.findIndex((p) => {
        try {
          return readdirSync(p.folder).some((f) => {
            const fl = f.toLowerCase();
            return fl.includes(stem) || fl.includes(stemNoExt);
          });
        } catch {
          return false;
        }
      });
      if (idx !== -1) {
        output[i] = remaining[idx].result;
        remaining.splice(idx, 1);
      }
    });

    // Second pass: fill any unmatched slots in remaining (mtime) order.
    for (let i = 0; i < output.length; i++) {
      if (output[i] === undefined && remaining.length > 0) {
        output[i] = remaining.shift()!.result;
      }
    }

    return output.map(
      (r) =>
        r ?? {
          text: '',
          segments: [],
          llmProcessed: false,
        },
    );
  }

  /** List immediate subdirectories of the recordings folder (candidate results). */
  private listResultFolders(recordingsDir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(recordingsDir);
    } catch {
      return [];
    }
    const folders: string[] = [];
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(recordingsDir, name);
      try {
        if (statSync(full).isDirectory()) folders.push(full);
      } catch {
        // ignore unreadable entries
      }
    }
    return folders;
  }

  /**
   * Resolve the Superwhisper recordings directory. Uses the configured path if
   * present, otherwise the current default (`~/superwhisper/recordings`), and
   * finally the pre-1.13 default (`~/Documents/superwhisper/recordings`).
   */
  private recordingsDir(settings: PlaudSettings): string {
    const configured = (settings.superwhisperRecordingsPath ?? '').trim();
    if (configured) {
      return configured.replace(/^~(?=$|\/)/, homedir());
    }
    const primary = join(homedir(), 'superwhisper', 'recordings');
    if (existsSync(primary)) return primary;
    const legacy = join(homedir(), 'Documents', 'superwhisper', 'recordings');
    if (existsSync(legacy)) return legacy;
    return primary;
  }

  private timeoutMs(settings: PlaudSettings): number {
    const mins = settings.superwhisperTimeoutMinutes;
    if (typeof mins === 'number' && mins > 0) return mins * 60_000;
    return DEFAULT_TIMEOUT_MS;
  }

  /**
   * Verify Superwhisper is reachable: the `open` tool exists, the Superwhisper
   * app is installed, and the recordings folder is present. Returns null on
   * success or a human-readable error string.
   */
  async checkInstallation(settings: PlaudSettings): Promise<string | null> {
    // 1. Is the Superwhisper app installed? Ask Launch Services.
    try {
      await execFileAsync(
        'osascript',
        ['-e', 'id of application "superwhisper"'],
        { timeout: 10_000 },
      );
    } catch (err: any) {
      return `Superwhisper app not found. Install it from superwhisper.com. (${err.message ?? err})`;
    }

    // 2. Does the recordings folder exist?
    const dir = this.recordingsDir(settings);
    if (!existsSync(dir)) {
      return `Superwhisper recordings folder not found at "${dir}". Open Superwhisper, transcribe once, or set the correct folder in settings.`;
    }

    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Back-compat alias. The plugin instantiates and references `WhisperBridge`
 * (as `plugin.whisperBridge`); keeping the name stable means the refactor is
 * confined to this file plus settings, not every call site.
 */
export { SuperwhisperBridge as WhisperBridge };
