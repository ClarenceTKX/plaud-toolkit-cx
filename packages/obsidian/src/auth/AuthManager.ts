import { Notice } from 'obsidian';
import { PlaudAuth, PlaudConfig } from '@plaud/core';
import type PlaudPlugin from '../../main';

/**
 * AuthManager — delegates to @plaud/core for automatic token management.
 * Tokens last ~300 days and auto-refresh when within 30 days of expiry.
 * Credentials are stored in ~/.plaud/config.json (shared with plaud-cli).
 */
export class AuthManager {
  private auth: PlaudAuth;
  private config: PlaudConfig;

  constructor(private plugin: PlaudPlugin) {
    this.config = new PlaudConfig();
    this.auth = new PlaudAuth(this.config);
  }

  /**
   * Returns a valid token, auto-refreshing if needed.
   * Throws if no credentials are configured.
   */
  async ensureToken(): Promise<string> {
    return this.auth.getToken();
  }

  /**
   * Check if the user is authenticated via either source: a token from Plaud's
   * passkey CLI (~/.plaud/tokens.json) or email/password creds (config.json).
   */
  isConfigured(): boolean {
    return !!this.config.getToken() || !!this.config.getCredentials();
  }

  /** Get the stored email (for display in settings). */
  getEmail(): string | undefined {
    return this.config.getCredentials()?.email;
  }

  /** Get the region (from passkey JWT or stored credentials). */
  getRegion(): string {
    return this.config.getRegion();
  }

  /** How much time remains on the cached token. */
  tokenStatus(): string {
    const token = this.config.getToken();
    if (!token) return 'no token';
    const remaining = token.expiresAt - Date.now();
    if (remaining <= 0) return 'expired';
    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    return `${days} days remaining`;
  }
}
