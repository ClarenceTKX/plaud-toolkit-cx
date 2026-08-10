import { PlaudAuth } from './auth.js';
import { BASE_URLS, fetchRequester } from './types.js';
import type { PlaudRecording, PlaudRecordingDetail, PlaudUserInfo, Requester } from './types.js';

/** Minimal config surface the client needs to persist a corrected region. */
export interface RegionStore {
  getCredentials(): { email: string; password: string; region: 'us' | 'eu' } | undefined;
  saveCredentials(credentials: { email: string; password: string; region: 'us' | 'eu' }): void;
}

export class PlaudClient {
  private auth: PlaudAuth;
  private region: string;
  private requester: Requester;
  private config?: RegionStore;

  constructor(
    auth: PlaudAuth,
    region: string = 'us',
    requester: Requester = fetchRequester,
    config?: RegionStore,
  ) {
    this.auth = auth;
    this.region = region;
    this.requester = requester;
    this.config = config;
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us'];
  }

  private async request(
    path: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
    retriedRegions: Set<string> = new Set(),
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
      throw new Error(`Plaud API error: ${res.status}`);
    }

    const data = await res.json();

    // ── Region mismatch auto-recovery ─────────────────────────────────────
    // Plaud rejects requests sent to the wrong regional endpoint. This can
    // arrive in a few shapes: a -302 status (sometimes with the correct domain
    // in data.domains.api, sometimes without), or a plain error message like
    // "user region mismatch". In every case: pick the right region, persist it,
    // and retry — guarding against retrying the same region twice.
    if (isRegionMismatch(data)) {
      const nextRegion = this.resolveMismatchRegion(data);
      if (nextRegion && nextRegion !== this.region && !retriedRegions.has(nextRegion)) {
        retriedRegions.add(this.region);
        this.setRegion(nextRegion);
        return this.request(path, options, retriedRegions);
      }
      // Couldn't resolve a new region to try — surface a clear, actionable error.
      const msg = data?.msg ?? data?.message ?? 'user region mismatch';
      throw new Error(
        `Plaud region mismatch and auto-correction failed (${msg}). ` +
          `Your account's region differs from the configured one; re-run \`plaud login\` and pick the other region (us/eu).`,
      );
    }

    return data;
  }

  /**
   * Choose the region to switch to on a mismatch. Prefer the domain Plaud
   * hands back; otherwise just toggle to the opposite of the current region.
   */
  private resolveMismatchRegion(data: any): 'us' | 'eu' | null {
    const domain: string | undefined = data?.data?.domains?.api ?? data?.domains?.api;
    if (typeof domain === 'string' && domain.length > 0) {
      return domain.includes('euc1') ? 'eu' : 'us';
    }
    // No domain hint — flip to the other known region.
    if (this.region === 'eu') return 'us';
    if (this.region === 'us') return 'eu';
    return null;
  }

  /** Switch the in-memory region and persist it to config when available. */
  private setRegion(region: 'us' | 'eu'): void {
    this.region = region;
    const creds = this.config?.getCredentials?.();
    if (creds && creds.region !== region) {
      this.config!.saveCredentials({ ...creds, region });
    }
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web');
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter(r => !r.is_trash);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    let transcript = '';
    const preDownload: any[] = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? '';
      if (content.length > transcript.length) transcript = content;
    }

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript,
    } as PlaudRecordingDetail;
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await this.requester({
      url: `${this.baseUrl}/file/download/${id}`,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Detect a region-mismatch response across the shapes Plaud returns it in:
 * the `-302` status code, or an error message mentioning a region mismatch.
 */
function isRegionMismatch(data: any): boolean {
  if (data?.status === -302) return true;
  const msg = String(data?.msg ?? data?.message ?? '').toLowerCase();
  return msg.includes('region mismatch') || msg.includes('user region');
}
