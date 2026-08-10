import { PlaudAuth } from './auth.js';
import { DEFAULT_API_BASE, fetchRequester } from './types.js';
import type {
  PlaudRecording,
  PlaudRecordingDetail,
  PlaudTranscriptSegment,
  PlaudUserInfo,
  Requester,
} from './types.js';

/** Config surface the client needs (API base + token access via auth). */
export interface ConfigStore {
  getApiBase(): string;
}

/** page_size bounds enforced by the platform API (validated server-side). */
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 100;

export class PlaudClient {
  private auth: PlaudAuth;
  private requester: Requester;
  private baseUrl: string;

  /**
   * @param auth       token provider
   * @param baseUrl    API base (e.g. https://platform.plaud.ai/developer/api).
   *                   A ConfigStore may be passed instead to resolve it.
   * @param requester  HTTP transport (defaults to fetch)
   */
  constructor(
    auth: PlaudAuth,
    baseUrl: string | ConfigStore = DEFAULT_API_BASE,
    requester: Requester = fetchRequester,
    _config?: ConfigStore, // back-compat: previously the 4th arg
  ) {
    this.auth = auth;
    this.requester = requester;
    this.baseUrl =
      typeof baseUrl === 'string'
        ? stripTrailingSlash(baseUrl)
        : stripTrailingSlash(baseUrl.getApiBase());
  }

  private async request(
    path: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await this.requester({
      url,
      method: options?.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: options?.body,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = typeof body?.detail === 'string' ? `: ${body.detail}` : ` : ${JSON.stringify(body).slice(0, 200)}`;
      } catch { /* non-JSON error body */ }
      throw new Error(`Plaud API error ${res.status}${detail}`);
    }

    return res.json();
  }

  /**
   * List recordings (one page). The platform API requires page_size in
   * [10, 100]; values are clamped so callers can't trip a 422.
   */
  async listRecordings(page = 1, pageSize = 20): Promise<PlaudRecording[]> {
    const size = Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.floor(pageSize)));
    const p = Math.max(1, Math.floor(page));
    const data = await this.request(`/open/third-party/files/?page=${p}&page_size=${size}`);
    const list = extractList(data);
    return list.map(normalizeRecording);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/open/third-party/files/${id}`);
    const raw = unwrap(data);
    const base = normalizeRecording(raw);

    // Transcript lives in `source_list` (data_type "transaction", a JSON
    // string of {start_time,end_time,content,speaker,original_speaker} segments);
    // the AI summary lives in `note_list` (data_type "auto_sum_note", markdown).
    const segments = extractTranscriptSegments(raw);
    const transcriptText = extractTranscript(raw);
    const summaryText = extractSummary(raw);

    return {
      ...base,
      audio: typeof raw?.presigned_url === 'string' ? true : base.audio,
      presigned_url: typeof raw?.presigned_url === 'string' ? raw.presigned_url : undefined,
      transcript: transcriptText.length > 0 ? true : base.transcript,
      summary: summaryText ? true : base.summary,
      transcriptText,
      segments,
      summaryText: summaryText || undefined,
    };
  }

  /** Get a temporary MP3 download URL (the platform detail's `presigned_url`). */
  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/open/third-party/files/${id}`);
      const raw = unwrap(data);
      return typeof raw?.presigned_url === 'string' ? raw.presigned_url : null;
    } catch {
      return null;
    }
  }

  /** Download the audio bytes via the detail's presigned S3 URL. */
  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const url = await this.getMp3Url(id);
    if (!url) throw new Error(`No audio available for recording ${id}`);
    const res = await this.requester({ url });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/open/third-party/users/current');
    const user = unwrap(data);
    return {
      id: user.id ?? user.user_id ?? '',
      nickname: user.nickname ?? user.name ?? '',
      email: user.email ?? '',
      country: user.country ?? '',
      membership_type: user.membership_type ?? user.plan ?? 'unknown',
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Unwrap a `{ data: … }` envelope if present, else return the value as-is. */
function unwrap(data: any): any {
  if (data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
    return data.data;
  }
  return data;
}

/** Pull the recordings array out of the response across likely wrapper shapes. */
function extractList(data: any): any[] {
  const d = data?.data ?? data;
  const candidates = [d?.files, d?.items, d?.list, d?.results, d?.records, d];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * Build the transcript from `source_list`. The transcript entry has
 * `data_type: "transaction"` and `data_content` is a JSON-encoded array of
 * `{ start_time, end_time, content }` segments (times in milliseconds).
 * Returns the segments joined into readable text; falls back to raw content if
 * it isn't the expected JSON.
 */
function extractTranscript(raw: any): string {
  const sources: any[] = Array.isArray(raw?.source_list) ? raw.source_list : [];
  const entry =
    sources.find((s) => String(s?.data_type).toLowerCase() === 'transaction') ??
    sources.find((s) => typeof s?.data_content === 'string' && s.data_content.trim().startsWith('['));
  const content = entry?.data_content;
  if (typeof content !== 'string' || !content.trim()) return '';

  try {
    const segs = JSON.parse(content);
    if (Array.isArray(segs)) {
      // Prefix each turn with its speaker when diarization is present, grouping
      // consecutive same-speaker segments under one label.
      const lines: string[] = [];
      let lastSpeaker: string | undefined;
      for (const s of segs) {
        const text = String(s?.content ?? '').trim();
        if (!text) continue;
        const speaker = typeof s?.speaker === 'string' ? s.speaker.trim() : '';
        if (speaker && speaker !== lastSpeaker) {
          lines.push(`${speaker}: ${text}`);
          lastSpeaker = speaker;
        } else if (speaker) {
          lines.push(text); // same speaker continues
        } else {
          lines.push(text);
          lastSpeaker = undefined;
        }
      }
      return lines.join('\n').trim();
    }
  } catch {
    // not JSON — return as-is
  }
  return content.trim();
}

/**
 * Structured transcript segments from `source_list`, with times in seconds
 * (converted from the API's milliseconds) and speaker labels when Plaud's
 * diarization provides them. Empty when unavailable.
 */
export function extractTranscriptSegments(raw: any): PlaudTranscriptSegment[] {
  const sources: any[] = Array.isArray(raw?.source_list) ? raw.source_list : [];
  const entry = sources.find((s) => String(s?.data_type).toLowerCase() === 'transaction');
  const content = entry?.data_content;
  if (typeof content !== 'string') return [];
  try {
    const segs = JSON.parse(content);
    if (!Array.isArray(segs)) return [];
    return segs
      .map((s): PlaudTranscriptSegment => {
        const seg: PlaudTranscriptSegment = {
          start: (Number(s?.start_time) || 0) / 1000,
          end: (Number(s?.end_time) || 0) / 1000,
          text: String(s?.content ?? '').trim(),
        };
        const speaker = typeof s?.speaker === 'string' ? s.speaker.trim() : '';
        const original = typeof s?.original_speaker === 'string' ? s.original_speaker.trim() : '';
        if (speaker) seg.speaker = speaker;
        if (original) seg.original_speaker = original;
        return seg;
      })
      .filter((s) => s.text.length > 0);
  } catch {
    return [];
  }
}

/**
 * AI summary markdown from `note_list` (`data_type: "auto_sum_note"`), falling
 * back to any note entry that carries `data_content`.
 */
function extractSummary(raw: any): string | undefined {
  const notes: any[] = Array.isArray(raw?.note_list) ? raw.note_list : [];
  const summary =
    notes.find((n) => String(n?.data_type).toLowerCase().includes('sum')) ??
    notes.find((n) => typeof n?.data_content === 'string' && n.data_content.trim());
  const content = summary?.data_content;
  return typeof content === 'string' && content.trim() ? content : undefined;
}

/**
 * Normalize a platform-API file object into `PlaudRecording`, populating both
 * the canonical fields and the legacy aliases older consumers still read.
 */
function normalizeRecording(raw: any): PlaudRecording {
  const id = raw?.id ?? raw?.file_id ?? '';
  const name = raw?.name ?? raw?.filename ?? raw?.file_name ?? String(id);
  const createdAt = raw?.created_at ?? raw?.create_time ?? raw?.createdAt ?? '';
  const startAt = raw?.start_at ?? raw?.start_time_iso ?? undefined;
  const duration = Number(raw?.duration ?? 0) || 0;

  // Legacy epoch-ms mirror of the start time (some consumers expect a number).
  const startMs = toEpochMs(startAt ?? createdAt);

  return {
    id,
    name,
    created_at: createdAt,
    duration,
    start_at: startAt,
    serial_number: raw?.serial_number ?? raw?.serialNumber,
    audio: coerceBool(raw?.audio),
    transcript: coerceBool(raw?.transcript),
    summary: coerceBool(raw?.summary),

    // legacy aliases
    filename: name,
    fullname: raw?.fullname ?? raw?.full_name,
    start_time: startMs,
    is_trash: coerceBool(raw?.is_trash) ?? false,
    is_trans: coerceBool(raw?.transcript ?? raw?.is_trans),
    is_summary: coerceBool(raw?.summary ?? raw?.is_summary),
  };
}

function coerceBool(v: any): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function toEpochMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
