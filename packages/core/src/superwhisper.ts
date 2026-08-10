import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const execFileAsync = promisify(execFile);

/**
 * On-device Superwhisper bridge — no UI or host dependencies, so it is shared
 * by both the CLI and the Obsidian plugin.
 *
 * Superwhisper is fire-and-forget: hand it a file with `open <file> -a
 * superwhisper`, it transcribes in the background using its currently active
 * *mode*, and writes the result into a new timestamped folder under the
 * recordings directory (default `~/superwhisper/recordings`) as `meta.json`.
 * This bridge launches transcription, then watches that folder for the freshly
 * written `meta.json`.
 */

// ── Result types ─────────────────────────────────────────────────────────────

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
  language?: string;
}

/** One entry of Superwhisper's `segments` array. */
export interface SuperwhisperSegment {
  text?: string;
  start?: number;
  end?: number;
}

/**
 * The subset of `meta.json` fields the bridge relies on. Verified against a
 * real Superwhisper 2.17.2 export (Parakeet, voice-only "Default" mode — no
 * `llmResult` present).
 */
export interface SuperwhisperMeta {
  result?: string;
  llmResult?: string;
  rawResult?: string;
  segments?: SuperwhisperSegment[];
  datetime?: string;
  /** Recording length in **milliseconds**. */
  duration?: number;
  modelKey?: string;
  modelName?: string;
  languageSelected?: string;
  languageModelKey?: string;
  languageModelName?: string;
  promptContext?: {
    systemContext?: { language?: string };
    modeContext?: { language?: string; type?: string };
  };
  modeName?: string;
}

export interface SuperwhisperMetaInfo {
  modelName?: string;
  modeName?: string;
  /** Recording duration in seconds (converted from meta's milliseconds). */
  durationSeconds?: number;
  datetime?: string;
}

export interface SuperwhisperTranscription extends TranscriptionResult {
  /** True when the transcript came from `llmResult`; false when it fell back to `result`. */
  llmProcessed: boolean;
  /** Absolute path of the recording folder the result was read from. */
  recordingFolder?: string;
  meta?: SuperwhisperMetaInfo;
}

// ── Pure parsing (unit-testable, no fs) ──────────────────────────────────────

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

/** Map Superwhisper segments into `{ start, end, text }` (seconds). */
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

// ── Bridge ───────────────────────────────────────────────────────────────────

export interface SuperwhisperOptions {
  /** Superwhisper recordings folder. Empty/absent → auto-detect. */
  recordingsPath?: string;
  /** Max minutes to wait for a result. Default 10. */
  timeoutMinutes?: number;
  /** Progress callback: number of results ready so far. */
  onProgress?: (ready: number, expected: number) => void;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;
const META_FILENAME = 'meta.json';

export class SuperwhisperBridge {
  /** Transcribe a single audio file. */
  async transcribe(
    audioAbsPath: string,
    options: SuperwhisperOptions = {},
  ): Promise<SuperwhisperTranscription> {
    const results = await this.transcribeBatch([audioAbsPath], options);
    return results[0];
  }

  /**
   * Transcribe several files, resolving only once the same number of new result
   * folders (each with a completed `meta.json`) have appeared. Results line up
   * with the input order where the source file can be matched, otherwise by
   * result modification time.
   */
  async transcribeBatch(
    audioAbsPaths: string[],
    options: SuperwhisperOptions = {},
  ): Promise<SuperwhisperTranscription[]> {
    if (audioAbsPaths.length === 0) return [];

    const recordingsDir = resolveRecordingsDir(options.recordingsPath);
    if (!existsSync(recordingsDir)) {
      throw new Error(
        `Superwhisper recordings folder not found at "${recordingsDir}". ` +
          `Set it explicitly, and make sure Superwhisper is installed and has run at least once.`,
      );
    }

    const triggerTime = Date.now();
    const seenBefore = new Set(listResultFolders(recordingsDir));

    for (const audioPath of audioAbsPaths) {
      if (!existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
      await launchSuperwhisper(audioPath);
    }

    const expected = audioAbsPaths.length;
    const timeoutMs = resolveTimeout(options.timeoutMinutes);

    const newFolders = await awaitResultFolders(
      recordingsDir,
      seenBefore,
      triggerTime,
      expected,
      timeoutMs,
      options.onProgress,
    );

    const parsed = newFolders.map((folder) => ({ folder, result: readMeta(folder) }));
    return alignResults(audioAbsPaths, parsed);
  }

  /**
   * Verify Superwhisper is reachable: the app is installed and the recordings
   * folder exists. Returns null on success or a human-readable error.
   */
  async checkInstallation(recordingsPath?: string): Promise<string | null> {
    try {
      await execFileAsync('osascript', ['-e', 'id of application "superwhisper"'], {
        timeout: 10_000,
      });
    } catch (err: any) {
      return `Superwhisper app not found. Install it from superwhisper.com. (${err.message ?? err})`;
    }
    const dir = resolveRecordingsDir(recordingsPath);
    if (!existsSync(dir)) {
      return `Superwhisper recordings folder not found at "${dir}". Open Superwhisper, transcribe once, or set the correct folder.`;
    }
    return null;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function launchSuperwhisper(audioAbsPath: string): Promise<void> {
  const env = {
    ...process.env,
    HOME: homedir(),
    PATH: `/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
  };
  try {
    await execFileAsync('open', [audioAbsPath, '-a', 'superwhisper'], { timeout: 30_000, env });
  } catch (err: any) {
    const stderr = err.stderr ?? '';
    throw new Error(
      `Failed to launch Superwhisper for "${basename(audioAbsPath)}": ${err.message ?? err}` +
        (stderr ? `\nstderr: ${stderr}` : ''),
    );
  }
}

async function awaitResultFolders(
  recordingsDir: string,
  seenBefore: Set<string>,
  triggerTime: number,
  expected: number,
  timeoutMs: number,
  onProgress?: (ready: number, expected: number) => void,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastReadyCount = -1;

  while (Date.now() < deadline) {
    const ready: { folder: string; mtime: number }[] = [];
    for (const folder of listResultFolders(recordingsDir)) {
      if (seenBefore.has(folder)) continue;
      const metaPath = join(folder, META_FILENAME);
      if (!existsSync(metaPath)) continue;
      let mtime: number;
      try {
        mtime = statSync(metaPath).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < triggerTime) continue;
      ready.push({ folder, mtime });
    }

    if (onProgress && ready.length !== lastReadyCount) {
      onProgress(ready.length, expected);
      lastReadyCount = ready.length;
    }

    if (ready.length >= expected) {
      return ready.sort((a, b) => a.mtime - b.mtime).slice(0, expected).map((r) => r.folder);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Superwhisper transcription timed out after ${Math.round(timeoutMs / 1000)}s ` +
      `(waiting for ${expected} result(s)). Check that Superwhisper is running and a valid mode is active.`,
  );
}

function readMeta(folder: string): SuperwhisperTranscription {
  const metaPath = join(folder, META_FILENAME);
  let meta: SuperwhisperMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as SuperwhisperMeta;
  } catch (err) {
    throw new Error(`Failed to parse Superwhisper meta.json at ${metaPath}: ${err}`);
  }
  return transcriptionFromMeta(meta, folder);
}

function alignResults(
  audioAbsPaths: string[],
  parsed: { folder: string; result: SuperwhisperTranscription }[],
): SuperwhisperTranscription[] {
  if (audioAbsPaths.length === 1) return parsed.map((p) => p.result);

  const remaining = [...parsed];
  const output: (SuperwhisperTranscription | undefined)[] = new Array(audioAbsPaths.length).fill(
    undefined,
  );

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

  for (let i = 0; i < output.length; i++) {
    if (output[i] === undefined && remaining.length > 0) {
      output[i] = remaining.shift()!.result;
    }
  }

  return output.map((r) => r ?? { text: '', segments: [], llmProcessed: false });
}

function listResultFolders(recordingsDir: string): string[] {
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
      /* ignore */
    }
  }
  return folders;
}

/** Resolve the recordings dir: explicit path, else current then legacy default. */
export function resolveRecordingsDir(recordingsPath?: string): string {
  const configured = (recordingsPath ?? '').trim();
  if (configured) return configured.replace(/^~(?=$|\/)/, homedir());
  const primary = join(homedir(), 'superwhisper', 'recordings');
  if (existsSync(primary)) return primary;
  const legacy = join(homedir(), 'Documents', 'superwhisper', 'recordings');
  if (existsSync(legacy)) return legacy;
  return primary;
}

function resolveTimeout(timeoutMinutes?: number): number {
  if (typeof timeoutMinutes === 'number' && timeoutMinutes > 0) return timeoutMinutes * 60_000;
  return DEFAULT_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
