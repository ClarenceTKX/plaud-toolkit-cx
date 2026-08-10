import { requestUrl } from 'obsidian';
import { PlaudAuth, PlaudClient as CoreClient, PlaudConfig } from '@plaud/core';
import type { PlaudRecording, PlaudRecordingDetail, Requester } from '@plaud/core';
import type PlaudPlugin from '../../main';

/**
 * Obsidian transport for @plaud/core. The renderer's `fetch` is blocked by
 * CORS when calling the Plaud API, so we route every core request through
 * Obsidian's `requestUrl`, which runs in the main process and bypasses CORS.
 */
const obsidianRequester: Requester = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method ?? 'GET',
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    json: async () => res.json,
    arrayBuffer: async () => res.arrayBuffer,
  };
};

/**
 * Thin wrapper around @plaud/core's PlaudClient, adapted for Obsidian.
 * Delegates API calls to the core library and adds Obsidian-specific
 * methods (downloadFromUrl, trashRecording).
 */
export class PlaudClient {
  private plugin: PlaudPlugin;
  private core: CoreClient;
  private auth: PlaudAuth;
  private config: PlaudConfig;

  constructor(plugin: PlaudPlugin) {
    this.plugin = plugin;
    // Single source of truth: the CLI-managed ~/.plaud/config.json. Region is
    // read from there (not a plugin setting) and passed into core so any region
    // mismatch auto-corrects and persists back to the shared config.
    this.config = new PlaudConfig();
    this.auth = new PlaudAuth(this.config, obsidianRequester);
    this.core = new CoreClient(this.auth, this.config.getRegion(), obsidianRequester, this.config);
  }

  /** Current region from the shared config (passkey JWT or creds; defaults to eu). */
  private get region(): 'us' | 'eu' {
    return this.config.getRegion();
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    return this.core.listRecordings();
  }

  async getRecordingDetail(id: string): Promise<PlaudRecordingDetail> {
    return this.core.getRecording(id);
  }

  async downloadAudioBuffer(id: string): Promise<ArrayBuffer> {
    return this.core.downloadAudio(id);
  }

  async getMp3TempUrl(id: string): Promise<string | null> {
    return this.core.getMp3Url(id);
  }

  /** Ensure we have a valid token (delegates to @plaud/core auto-refresh). */
  async ensureToken(): Promise<string> {
    return this.auth.getToken();
  }

  /** Check if credentials are configured in ~/.plaud/config.json. */
  hasCredentials(): boolean {
    const config = new PlaudConfig();
    return !!config.getCredentials();
  }

  /**
   * Download a buffer from an arbitrary URL (e.g. a signed S3 temp URL).
   * Uses Obsidian's requestUrl for compatibility.
   */
  async downloadFromUrl(url: string): Promise<ArrayBuffer> {
    const response = await requestUrl({ url, method: 'GET' });
    if (response.status !== 200) {
      throw new Error(`Download failed: ${response.status}`);
    }
    return response.arrayBuffer;
  }

  /**
   * Trash a recording on Plaud servers.
   * Not in @plaud/core — uses Obsidian's requestUrl directly.
   */
  async trashRecording(id: string): Promise<boolean> {
    const token = await this.auth.getToken();
    const baseUrl = this.region === 'eu'
      ? 'https://api-euc1.plaud.ai'
      : 'https://api.plaud.ai';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    try {
      const res = await requestUrl({
        url: `${baseUrl}/file/${id}`,
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_trash: true }),
      });
      if (res.status >= 200 && res.status < 300) return true;
    } catch (e: any) {
      console.log('Plaud: PATCH trash failed, trying POST fallback', e.message);
    }

    try {
      const res = await requestUrl({
        url: `${baseUrl}/file/trash`,
        method: 'POST',
        headers,
        body: JSON.stringify({ file_ids: [id] }),
      });
      if (res.status >= 200 && res.status < 300) return true;
      console.warn('Plaud: POST /file/trash returned', res.status, res.text);
      return false;
    } catch (e: any) {
      console.error('Plaud: trashRecording failed for', id, e);
      return false;
    }
  }
}
