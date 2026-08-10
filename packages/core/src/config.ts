import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_API_BASE } from './types.js';
import type { PlaudConfig as PlaudConfigData, PlaudCredentials, PlaudTokenData } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.plaud');
const CONFIG_FILE = 'config.json';
/** Written by Plaud's official passkey/browser CLI login (`plaud login`). */
const TOKENS_FILE = 'tokens.json';
/** Optional CLI config (`api_base`, `timeout`), shared with @plaud-ai/cli. */
const CLI_YAML_FILE = 'cli.yaml';

/** Shape of Plaud's official CLI `tokens.json`. */
interface PlaudCliTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number; // epoch ms
}

export class PlaudConfig {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
  }

  private filePath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  private tokensPath(): string {
    return path.join(this.dir, TOKENS_FILE);
  }

  load(): PlaudConfigData {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8');
      return JSON.parse(raw) as PlaudConfigData;
    } catch {
      return {};
    }
  }

  save(data: PlaudConfigData): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const existing = this.load();
    const merged = { ...existing, ...data };
    fs.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  }

  saveToken(token: PlaudTokenData): void {
    this.save({ token });
  }

  saveCredentials(credentials: PlaudCredentials): void {
    this.save({ credentials });
  }

  /**
   * A valid token, from whichever source is available:
   *  1. `config.json` token (our own email/password login), if present.
   *  2. `tokens.json` written by Plaud's official passkey CLI login.
   * Returns undefined if neither exists.
   */
  getToken(): PlaudTokenData | undefined {
    const own = this.load().token;
    if (own) return own;
    return this.readCliTokens();
  }

  /** Refresh token from Plaud's CLI `tokens.json`, if present. */
  getRefreshToken(): string | undefined {
    const raw = this.readRawCliTokens();
    return raw?.refresh_token;
  }

  /**
   * Credentials for email/password login, if configured. Passkey users have no
   * stored credentials (they authenticate via `tokens.json`), so this may be
   * undefined even when a valid token exists.
   */
  getCredentials(): PlaudCredentials | undefined {
    return this.load().credentials;
  }

  /**
   * Region resolved from whatever auth source is available: explicit
   * credentials first, else the JWT `domain` claim inside `tokens.json`.
   * Defaults to 'eu' when it can't be determined.
   */
  getRegion(): 'us' | 'eu' {
    const creds = this.getCredentials();
    if (creds?.region === 'us' || creds?.region === 'eu') return creds.region;

    const tok = this.readCliTokens();
    if (tok) {
      const domain = jwtClaim(tok.accessToken, 'domain');
      if (typeof domain === 'string' && domain.length > 0) {
        return domain.includes('euc1') ? 'eu' : 'us';
      }
    }
    return 'eu';
  }

  /**
   * Resolve the API base URL, mirroring the official CLI's precedence:
   *   PLAUD_API_BASE env  →  ~/.plaud/cli.yaml `api_base`  →  built-in default.
   */
  getApiBase(): string {
    const fromEnv = process.env.PLAUD_API_BASE?.trim();
    if (fromEnv) return stripTrailingSlash(fromEnv);

    const fromYaml = this.readCliYamlApiBase();
    if (fromYaml) return stripTrailingSlash(fromYaml);

    return DEFAULT_API_BASE;
  }

  /** Minimal read of `api_base` from ~/.plaud/cli.yaml (no YAML dependency). */
  private readCliYamlApiBase(): string | undefined {
    try {
      const raw = fs.readFileSync(path.join(this.dir, CLI_YAML_FILE), 'utf-8');
      // Match:  api_base: "https://…"   |   api_base: https://…
      const m = raw.match(/^\s*api_base\s*:\s*["']?([^"'#\r\n]+)["']?\s*$/m);
      return m?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Read + normalize Plaud CLI `tokens.json` into our PlaudTokenData shape. */
  private readCliTokens(): PlaudTokenData | undefined {
    const raw = this.readRawCliTokens();
    if (!raw?.access_token) return undefined;

    // Prefer the file's expires_at; fall back to the JWT `exp` (seconds→ms).
    let expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at : 0;
    let issuedAt = Date.now();
    const exp = jwtClaim(raw.access_token, 'exp');
    const iat = jwtClaim(raw.access_token, 'iat');
    if (!expiresAt && typeof exp === 'number') expiresAt = exp * 1000;
    if (typeof iat === 'number') issuedAt = iat * 1000;

    return {
      accessToken: raw.access_token,
      tokenType: raw.token_type || 'bearer',
      issuedAt,
      expiresAt,
    };
  }

  private readRawCliTokens(): PlaudCliTokens | undefined {
    try {
      const raw = fs.readFileSync(this.tokensPath(), 'utf-8');
      return JSON.parse(raw) as PlaudCliTokens;
    } catch {
      return undefined;
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Decode a single claim from a JWT payload without verifying the signature. */
function jwtClaim(jwt: string, claim: string): unknown {
  try {
    const part = jwt.split('.')[1];
    if (!part) return undefined;
    const json = Buffer.from(part, 'base64url').toString('utf-8');
    return JSON.parse(json)[claim];
  } catch {
    return undefined;
  }
}
