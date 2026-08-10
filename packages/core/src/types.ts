export interface PlaudCredentials {
  email: string;
  password: string;
  region: 'us' | 'eu';
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms (decoded from JWT)
}

export interface PlaudConfig {
  credentials?: PlaudCredentials;
  token?: PlaudTokenData;
}

/**
 * Default base for Plaud's current platform API (the same one `@plaud-ai/cli`
 * uses). All personal-recording endpoints live under `/open/third-party/…`.
 */
export const DEFAULT_API_BASE = 'https://platform.plaud.ai/developer/api';

/** OAuth token + refresh endpoints (used by the passkey CLI flow). */
export const DEFAULT_TOKEN_URL = `${DEFAULT_API_BASE}/oauth/third-party/access-token`;
export const DEFAULT_REFRESH_URL = `${DEFAULT_API_BASE}/oauth/third-party/access-token/refresh`;

/**
 * @deprecated The API is no longer split by us/eu region — everything is served
 * from the single platform base. Retained only so older imports still resolve.
 */
export const BASE_URLS: Record<string, string> = {
  us: DEFAULT_API_BASE,
  eu: DEFAULT_API_BASE,
};

// Plaud's API rejects requests with the default Node.js fetch User-Agent
// ("node") with 403 Forbidden, so we send a browser-like UA on every request.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// HTTP transport abstraction. Defaults to `fetch` (Node/CLI), but hosts that
// can't use cross-origin fetch — e.g. an Obsidian plugin running in the
// renderer, which is blocked by CORS — can inject their own requester
// (Obsidian's `requestUrl`).
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type Requester = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchRequester: Requester = async (req) => {
  const res = await fetch(req.url, {
    method: req.method ?? 'GET',
    headers: { 'User-Agent': USER_AGENT, ...req.headers },
    body: req.body,
  });
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    arrayBuffer: () => res.arrayBuffer(),
  };
};

/**
 * A recording as returned by the platform API (`/open/third-party/files`).
 * Canonical fields follow the documented schema (name/created_at/duration/…);
 * legacy fields (filename/start_time/…) are kept optional and populated by the
 * client so existing consumers keep working during the migration.
 */
export interface PlaudRecording {
  id: string;
  /** Recording name (canonical). */
  name: string;
  /** Creation time, ISO 8601 (canonical). */
  created_at: string;
  /** Length of the recording, in **milliseconds** (platform API). */
  duration: number;
  /** Recording start time, ISO 8601. */
  start_at?: string;
  serial_number?: string;
  /** Availability flags (detail responses). */
  audio?: boolean;
  transcript?: boolean;
  summary?: boolean;

  // ── Legacy compatibility (populated by the client from the new fields) ──
  /** @deprecated use `name`. */
  filename?: string;
  /** @deprecated original file name incl. extension, when known. */
  fullname?: string;
  /** @deprecated use `created_at`/`start_at` (epoch ms mirror of start). */
  start_time?: number;
  /** @deprecated */
  is_trash?: boolean;
  /** @deprecated use boolean `transcript`. */
  is_trans?: boolean;
  /** @deprecated use boolean `summary`. */
  is_summary?: boolean;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  /** Temporary presigned S3 URL for the MP3 (valid ~24h), when available. */
  presigned_url?: string;
  /** Full transcript text (empty string when not available). */
  transcriptText?: string;
  /** AI summary markdown, when available. */
  summaryText?: string;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}
