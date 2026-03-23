/**
 * Zapier API Client (Headless)
 *
 * Lightweight HTTP client for Zapier's internal API using Playwright's
 * standalone `request.newContext()` — no Chromium process needed.
 *
 * Uses the same storageState file as the browser client, so cookies
 * are shared. When the session expires, throws an error that the CLI
 * layer catches to trigger a browser login + retry.
 *
 * Why request.newContext() instead of raw fetch():
 * - Automatic cookie handling (domain, path, expiry, secure flags)
 * - Better Cloudflare/WAF compatibility (proper TLS fingerprint)
 * - Same response API as the existing browser client code
 * - No manual cookie extraction from storageState
 */

import { request, APIRequestContext } from "playwright";
import { existsSync } from "fs";

// Paths — session data on tmpfs (RAM), never on disk
const SESSION_DIR = process.platform === "darwin"
  ? "YOUR_CREDENTIALS_PATH/sessions"
  : "YOUR_CREDENTIALS_PATH/sessions";
const STORAGE_STATE_PATH = `${SESSION_DIR}/zapier-storage-state.json`;

const ZAPIER_BASE = "https://zapier.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Internal API endpoints (same as browser client)
const API = {
  me: "/api/v3/me",
  zaps: "/api/v4/zaps",
  zapDetail: (zapId: string) => `/api/v4/zaps/${zapId}`,
  zapRuns: "/api/v4/zap-runs",
  zapRunDetail: (runId: string) => `/api/v4/zap-runs/${runId}`,
};

export class ZapierApiClient {
  private context: APIRequestContext | null = null;
  private debug: boolean;

  constructor(options?: { debug?: boolean }) {
    this.debug = options?.debug ?? false;
  }

  /**
   * Creates an API request context using the saved storageState.
   * Throws if no session file exists (caller should trigger browser login).
   */
  async connect(): Promise<void> {
    if (this.context) return;

    if (!existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        "No session found. Run a browser command first to authenticate."
      );
    }

    this.context = await request.newContext({
      storageState: STORAGE_STATE_PATH,
      userAgent: USER_AGENT,
      baseURL: ZAPIER_BASE,
      extraHTTPHeaders: {
        Accept: "application/json",
      },
    });

    if (this.debug) console.error("[api-client] Connected with storageState");
  }

  /**
   * Validates whether the session cookies are still valid.
   */
  async isSessionValid(): Promise<boolean> {
    if (!this.context) return false;
    try {
      const response = await this.context.get(API.me);
      return response.ok();
    } catch {
      return false;
    }
  }

  /**
   * Makes an authenticated GET request to Zapier's internal API.
   */
  async get(path: string, params?: Record<string, string>): Promise<any> {
    this.ensureConnected();

    let url = path;
    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    if (this.debug) console.error(`[api-client] GET ${path}`);
    const response = await this.context!.get(url);

    return this.handleResponse(response, "GET", path);
  }

  /**
   * Makes an authenticated PATCH request to Zapier's internal API.
   */
  async patch(path: string, data: Record<string, unknown>): Promise<any> {
    this.ensureConnected();

    if (this.debug) console.error(`[api-client] PATCH ${path}`);
    const response = await this.context!.patch(path, {
      headers: { "Content-Type": "application/json" },
      data,
    });

    return this.handleResponse(response, "PATCH", path);
  }

  /**
   * Makes an authenticated POST request to Zapier's internal API.
   */
  async post(path: string, data?: Record<string, unknown>): Promise<any> {
    this.ensureConnected();

    if (this.debug) console.error(`[api-client] POST ${path}`);
    const response = await this.context!.post(path, {
      headers: { "Content-Type": "application/json" },
      ...(data ? { data } : {}),
    });

    return this.handleResponse(response, "POST", path);
  }

  /**
   * Disposes the API request context, freeing resources.
   */
  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.dispose();
      this.context = null;
    }
  }

  /**
   * Reconnects by disposing and recreating the context.
   * Useful after a browser login refreshes the storageState.
   */
  async reconnect(): Promise<void> {
    await this.dispose();
    await this.connect();
  }

  // --- Internal helpers ---

  private ensureConnected(): void {
    if (!this.context) {
      throw new Error("API client not connected. Call connect() first.");
    }
  }

  private async handleResponse(
    response: { ok(): boolean; status(): number; statusText(): string; text(): Promise<string>; json(): Promise<any> },
    method: string,
    path: string
  ): Promise<any> {
    if (response.ok()) {
      return response.json();
    }

    const status = response.status();
    const body = await response.text().catch(() => "");

    // Session expired — signal caller to re-authenticate
    if (status === 401 || status === 403) {
      throw new SessionExpiredError(
        `Authentication failed (${status}) on ${method} ${path}. Session may be expired.`
      );
    }

    throw new Error(
      `API ${method} ${path} failed: ${status} ${response.statusText()} — ${body.substring(0, 500)}`
    );
  }
}

/**
 * Distinct error class so the CLI can catch session expiry
 * and trigger browser re-login before retrying.
 */
export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export { API as ZAPIER_API_PATHS };
export default ZapierApiClient;
