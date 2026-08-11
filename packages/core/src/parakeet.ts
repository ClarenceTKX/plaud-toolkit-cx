import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Bridge to `macparakeet-cli` — local, synchronous speech-to-text on Apple
 * Silicon (Parakeet TDT), with optional LLM-backed summaries via its prompt
 * library. Unlike the old Superwhisper bridge, this is a plain CLI: it returns
 * results on stdout, never pastes into the focused app, and supports batch use.
 *
 * All shapes verified against a real `macparakeet-cli` history dump
 * (transcriptSegments with startMs/endMs/text/speakerId/speakerLabel).
 */

const CLI = 'macparakeet-cli';

// ── Result types ─────────────────────────────────────────────────────────────

export interface ParakeetSegment {
  /** Start time in seconds (converted from the CLI's milliseconds). */
  start: number;
  /** End time in seconds. */
  end: number;
  text: string;
  /** Diarization label, e.g. "Speaker 1" (from `speakerLabel`). */
  speaker?: string;
  /** Raw speaker id, e.g. "S1" (from `speakerId`). */
  speakerId?: string;
}

export interface ParakeetTranscription {
  /** History id — required to run summary prompts against this transcription. */
  id: string;
  /** Flattened transcript text (speaker-prefixed when diarized). */
  text: string;
  /** Structured segments (times in seconds, with speaker labels). */
  segments: ParakeetSegment[];
  /** Detected language, e.g. "en". */
  language?: string;
  /** Duration in milliseconds (as reported by the CLI). */
  durationMs?: number;
  speakerCount?: number;
}

export interface ParakeetHealth {
  ok: boolean;
  /** Raw parsed `health --json` payload. */
  raw: any;
  /** Human-readable reason when not ok. */
  reason?: string;
}

export interface TranscribeOptions {
  /** Exact known speaker count (per-run; implies diarization). */
  speakerCount?: number;
  speakerMin?: number;
  speakerMax?: number;
  /** Turn diarization off for this run. */
  noDiarize?: boolean;
  /**
   * Keep the transcription in macparakeet history. Default true — a history id
   * is required to run summary prompts. Pass false for one-off transcripts.
   */
  keepHistory?: boolean;
}

export interface ParakeetPrompt {
  id: string;
  name: string;
  category?: string;
  isBuiltIn: boolean;
  isVisible: boolean;
}

export interface SummaryOptions {
  /** Prompt library entry name, e.g. "Summary", "Action Items & Decisions". */
  promptName?: string;
  /**
   * macparakeet provider: anthropic, openai, ollama, cli, … Defaults to "cli",
   * which runs summaries through a local command (Claude Code) with no API key.
   */
  provider?: string;
  /**
   * Command for the `cli` provider (default "claude -p"). Ignored for other
   * providers.
   */
  command?: string;
  /** Env var holding the API key — only for hosted providers (anthropic, etc.). */
  apiKeyEnv?: string;
  /** Model id — ignored by the `cli` provider (it reports model "cli"). */
  model?: string;
}

/** A macparakeet CLI failure, carrying the stable `errorType` when present. */
export class ParakeetError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly errorType?: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'ParakeetError';
  }
}

// ── Bridge ───────────────────────────────────────────────────────────────────

export class ParakeetBridge {
  constructor(private cli: string = CLI) {}

  /**
   * Probe model/db/binary readiness. Returns `{ok:false, reason}` rather than
   * throwing so callers can decide whether to proceed.
   */
  async health(): Promise<ParakeetHealth> {
    let out: string;
    try {
      out = (await this.run(['health', '--json'])).stdout;
    } catch (err) {
      if (err instanceof ParakeetError) {
        return { ok: false, raw: null, reason: err.message };
      }
      return { ok: false, raw: null, reason: String(err) };
    }
    let raw: any;
    try {
      raw = JSON.parse(out);
    } catch {
      return { ok: false, raw: null, reason: 'health returned non-JSON output' };
    }
    const dbOk = raw?.database?.status === 'ok';
    const modelOk =
      raw?.speechStack?.parakeetModelDownloaded === true ||
      raw?.speechStack?.speechModelCached === true;
    if (!dbOk) return { ok: false, raw, reason: `database not ready (${raw?.database?.status})` };
    if (!modelOk) return { ok: false, raw, reason: 'Parakeet speech model not downloaded' };
    return { ok: true, raw };
  }

  /**
   * Transcribe a local audio/video file. Returns the structured transcript
   * (segments in seconds, with speaker labels) plus the history `id` needed for
   * summaries. `--format json` prints progress/profiling to stderr, so we parse
   * stdout only.
   */
  async transcribe(
    fileAbsPath: string,
    options: TranscribeOptions = {},
  ): Promise<ParakeetTranscription> {
    const args = ['transcribe', fileAbsPath, '--format', 'json'];
    if (options.keepHistory === false) args.push('--no-history');
    if (options.noDiarize) args.push('--no-diarize');
    if (typeof options.speakerCount === 'number') args.push('--speaker-count', String(options.speakerCount));
    if (typeof options.speakerMin === 'number') args.push('--speaker-min', String(options.speakerMin));
    if (typeof options.speakerMax === 'number') args.push('--speaker-max', String(options.speakerMax));

    const { stdout } = await this.run(args, { maxBuffer: 64 * 1024 * 1024 });
    let raw: any;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new ParakeetError('macparakeet transcribe returned non-JSON output', 0);
    }
    // A parsed failure envelope still exits 0 in some paths — guard on `ok:false`.
    if (raw && raw.ok === false) {
      throw new ParakeetError(raw.error ?? 'transcription failed', 0, raw.errorType, raw.fix);
    }
    return parseTranscription(raw);
  }

  /**
   * Run a summary prompt against an existing transcription id (LLM-backed).
   * Returns the generated markdown (`output`). The API key stays in an env var
   * — never passed as a literal argument.
   */
  async summarize(
    transcriptionId: string,
    options: SummaryOptions = {},
  ): Promise<string> {
    const promptName = options.promptName ?? 'Summary';
    // Default to the local `cli` provider running Claude Code (`claude -p`) — no
    // API key required. Hosted providers (anthropic, …) use an env-var key.
    const provider = options.provider ?? 'cli';

    const args = [
      'prompts', 'run', promptName,
      '--transcription', transcriptionId,
      '--provider', provider,
      '--json',
    ];

    if (provider === 'cli') {
      args.push('--command', options.command ?? 'claude -p');
      args.push('--local');
    } else {
      args.push('--api-key-env', options.apiKeyEnv ?? 'ANTHROPIC_API_KEY');
      if (options.model) args.push('--model', options.model);
    }

    const { stdout } = await this.run(args, { maxBuffer: 32 * 1024 * 1024 });
    let env: any;
    try {
      env = JSON.parse(stdout);
    } catch {
      throw new ParakeetError('macparakeet prompts run returned non-JSON output', 0);
    }
    if (env && env.ok === false) {
      throw new ParakeetError(env.error ?? 'summary failed', 0, env.errorType, env.fix);
    }
    const output = env?.output ?? env?.data?.output;
    if (typeof output !== 'string' || output.trim().length === 0) {
      throw new ParakeetError('macparakeet prompts run produced no output', 0);
    }
    return output;
  }

  /** List the saved summary prompts from macparakeet's prompt library. */
  async listPrompts(): Promise<ParakeetPrompt[]> {
    const { stdout } = await this.run(['prompts', 'list', '--json']);
    let raw: any;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new ParakeetError('macparakeet prompts list returned non-JSON output', 0);
    }
    const rows: any[] = Array.isArray(raw) ? raw : (raw?.prompts ?? raw?.data ?? []);
    return rows
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? ''),
        category: p.category ? String(p.category) : undefined,
        isBuiltIn: !!p.isBuiltIn,
        isVisible: p.isVisible !== false,
      }))
      .filter((p) => p.name.length > 0 && p.isVisible);
  }

  /** Run the CLI, translating exit codes into ParakeetError per the skill contract. */
  private async run(
    args: string[],
    opts: { maxBuffer?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(this.cli, args, {
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        timeout: 30 * 60_000, // 30 min ceiling for long recordings
      });
      return { stdout, stderr };
    } catch (err: any) {
      const code: number | null = typeof err?.code === 'number' ? err.code : null;
      // exit 2 = invocation misuse (plain-text stderr); 130 = SIGINT; 1 = runtime.
      if (err?.stdout) {
        // After arg-parsing succeeds, failures come back as a JSON envelope on stdout.
        try {
          const env = JSON.parse(err.stdout);
          if (env && env.ok === false) {
            throw new ParakeetError(env.error ?? 'macparakeet error', code, env.errorType, env.fix);
          }
        } catch {
          /* not JSON — fall through */
        }
      }
      if (err?.code === 'ENOENT') {
        throw new ParakeetError(
          `macparakeet-cli not found. Install it: brew install moona3k/tap/macparakeet-cli`,
          null,
          'not_installed',
        );
      }
      const stderr = (err?.stderr ?? '').toString().trim();
      throw new ParakeetError(
        `macparakeet-cli ${args[0]} failed${code != null ? ` (exit ${code})` : ''}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
        code,
      );
    }
  }
}

// ── Pure parsing (unit-testable) ─────────────────────────────────────────────

/** Parse a macparakeet transcribe/history object into our transcription shape. */
export function parseTranscription(raw: any): ParakeetTranscription {
  const segments = mapParakeetSegments(raw?.transcriptSegments);
  return {
    id: String(raw?.id ?? ''),
    text: segments.length > 0 ? flattenSegments(segments) : String(raw?.rawTranscript ?? '').trim(),
    segments,
    language: raw?.language ?? undefined,
    durationMs: typeof raw?.durationMs === 'number' ? raw.durationMs : undefined,
    speakerCount: typeof raw?.speakerCount === 'number' ? raw.speakerCount : undefined,
  };
}

/** Map `transcriptSegments` (startMs/endMs/text/speaker*) into seconds + speaker. */
export function mapParakeetSegments(segments: any): ParakeetSegment[] {
  if (!Array.isArray(segments)) return [];
  const out: ParakeetSegment[] = [];
  for (const s of segments) {
    if (s == null || typeof s !== 'object') continue;
    const text = String(s.text ?? '').trim();
    if (!text) continue;
    const seg: ParakeetSegment = {
      start: (Number(s.startMs) || 0) / 1000,
      end: (Number(s.endMs) || 0) / 1000,
      text,
    };
    const label = typeof s.speakerLabel === 'string' ? s.speakerLabel.trim() : '';
    const sid = typeof s.speakerId === 'string' ? s.speakerId.trim() : '';
    if (label) seg.speaker = label;
    if (sid) seg.speakerId = sid;
    out.push(seg);
  }
  return out;
}

/** Speaker-prefixed flat text, grouping consecutive same-speaker turns. */
function flattenSegments(segments: ParakeetSegment[]): string {
  const lines: string[] = [];
  let last: string | undefined;
  for (const s of segments) {
    if (s.speaker && s.speaker !== last) {
      lines.push(`${s.speaker}: ${s.text}`);
      last = s.speaker;
    } else {
      lines.push(s.text);
      if (!s.speaker) last = undefined;
    }
  }
  return lines.join('\n').trim();
}
