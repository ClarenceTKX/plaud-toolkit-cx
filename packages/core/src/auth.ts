import { PlaudConfig } from './config.js';
import { BASE_URLS, fetchRequester } from './types.js';
import type { PlaudTokenData, Requester } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class PlaudAuth {
  private config: PlaudConfig;
  private requester: Requester;

  constructor(config: PlaudConfig, requester: Requester = fetchRequester) {
    this.config = config;
    this.requester = requester;
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken();
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.accessToken;
    }
    return this.login();
  }

  async login(): Promise<string> {
    const creds = this.config.getCredentials();
    if (!creds) {
      throw new Error('No credentials configured. Run `plaud login` first.');
    }

    // Auto-detect region: try the configured region first, then fall back to
    // the other one. Whichever succeeds is persisted, so the user never has to
    // know or pick their account's region correctly.
    const configured = (creds.region === 'us' || creds.region === 'eu') ? creds.region : 'eu';
    const order: Array<'us' | 'eu'> = configured === 'eu' ? ['eu', 'us'] : ['us', 'eu'];

    let lastError: Error | null = null;
    for (const region of order) {
      try {
        const token = await this.loginToRegion(creds.email, creds.password, region);
        // Persist the region that actually worked (if it changed).
        if (creds.region !== region) {
          this.config.saveCredentials({ ...creds, region });
        }
        return token;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only fall through to the other region on a region-type rejection or
        // network error; a genuine bad-password error should surface as-is.
        if (!isRegionOrNetworkError(lastError)) throw lastError;
      }
    }

    throw lastError ?? new Error('Login failed for all known regions.');
  }

  /** Attempt login against a single region's endpoint. Returns the access token. */
  private async loginToRegion(
    email: string,
    password: string,
    region: 'us' | 'eu',
  ): Promise<string> {
    const baseUrl = BASE_URLS[region] ?? BASE_URLS['us'];
    const body = new URLSearchParams({ username: email, password });

    const res = await this.requester({
      url: `${baseUrl}/auth/access-token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json() as {
      status: number;
      msg?: string;
      access_token: string;
      token_type: string;
    };

    if (data.status !== 0 || !data.access_token) {
      throw new Error(data.msg || `Login failed (status ${data.status})`);
    }

    const decoded = this.decodeJwtExpiry(data.access_token);
    const tokenData: PlaudTokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    };

    this.config.saveToken(tokenData);
    return data.access_token;
  }

  private isExpiringSoon(token: PlaudTokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}

/**
 * Should a failed login attempt fall through to the other region? Yes for
 * region-type rejections and transient network/DNS errors; no for a genuine
 * credential failure (which we want to surface immediately, unchanged).
 */
function isRegionOrNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  if (msg.includes('region')) return true;
  // Network/DNS/connection issues — worth trying the other endpoint.
  if (/(fetch failed|network|enotfound|econnrefused|etimedout|timeout|getaddrinfo)/.test(msg)) {
    return true;
  }
  // A clear bad-credentials message should NOT trigger a region fallback.
  if (/(password|credential|unauthorized|invalid|incorrect)/.test(msg)) return false;
  // Ambiguous status-code failures: allow one cross-region retry.
  return msg.includes('login failed');
}
