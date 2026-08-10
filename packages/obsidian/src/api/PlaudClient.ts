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
    // Single source of truth: the CLI-managed ~/.plaud/. Auth comes from
    // tokens.json (passkey) or config.json; the API base URL is resolved by the
    // shared PlaudConfig (PLAUD_API_BASE / cli.yaml / platform default).
    this.config = new PlaudConfig();
    this.auth = new PlaudAuth(this.config, obsidianRequester);
    // Pass the config as the base-URL resolver (ConfigStore), NOT a region.
    this.core = new CoreClient(this.auth, this.config, obsidianRequester);
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
   * Attempt to trash a recording on Plaud's servers.
   *
   * The current platform API (`/developer/api/open/third-party/…`) does not
   * expose a documented delete/trash endpoint for personal recordings, so this
   * tries a best-effort DELETE on the file resource and reports failure (rather
   * than erroring) if it isn't supported — the caller then removes locally only.
   */
  async trashRecording(id: string): Promise<boolean> {
    const token = await this.auth.getToken();
    const base = this.config.getApiBase();
    try {
      const res = await requestUrl({
        url: `${base}/open/third-party/files/${id}`,
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        throw: false,
      });
      if (res.status >= 200 && res.status < 300) return true;
      console.warn(`Plaud: remote trash not supported (DELETE returned ${res.status}); removing locally only.`);
      return false;
    } catch (e: any) {
      console.warn('Plaud: remote trash failed; removing locally only.', e?.message ?? e);
      return false;
    }
  }
}
