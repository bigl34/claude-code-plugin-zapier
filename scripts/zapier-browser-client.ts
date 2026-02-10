/**
 * Zapier Browser Client
 *
 * Browser automation client for Zapier Zap management. Uses Playwright
 * for authentication, then calls Zapier's internal API endpoints via
 * page.request with the authenticated session cookies.
 *
 * Key features:
 * - StorageState-based session persistence (tmpfs, never on disk)
 * - Internal API for structured JSON responses (no DOM scraping)
 * - UI fallback for replay/toggle when no API endpoint exists
 * - --debug mode for headful browser (2FA, CAPTCHA, selector debugging)
 * - Screenshot capture at each step for verification
 *
 * Data flow: Browser login → save storageState → page.request.get/post()
 * against Zapier's internal API → structured JSON responses.
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths — session data on tmpfs (RAM), never on disk
const SESSION_DIR = "YOUR_CREDENTIALS_PATH/sessions";
const STORAGE_STATE_PATH = `${SESSION_DIR}/zapier-storage-state.json`;
const CDP_SESSION_PATH = `${SESSION_DIR}/zapier-session.json`;
const SCREENSHOT_DIR = "/home/USER/biz/.playwright-mcp";
const CONFIG_PATH = join(__dirname, "..", "config.json");

// Zapier URLs
const ZAPIER_LOGIN_URL = "https://zapier.com/app/login";
const ZAPIER_ZAPS_URL = "https://zapier.com/app/zaps";
const ZAPIER_HISTORY_URL = "https://zapier.com/app/history";
const ZAPIER_BASE = "https://zapier.com";

// Internal API endpoints — discovered via network interception.
// These may change; if they do, run with --debug and re-discover.
// Placeholder paths — will be confirmed during API discovery phase.
const API = {
  me: "/api/v3/me",
  zaps: "/api/v4/zaps",
  zapRuns: "/api/v4/zap-runs",
  zapRunDetail: (runId: string) => `/api/v4/zap-runs/${runId}`,
  toggleZap: (zapId: string) => `/api/v4/zaps/${zapId}`,
};

interface Config {
  mcpServer: {
    type: string;
    url: string;
    apiKey: string;
  };
  zapier?: {
    email: string;
    password: string;
  };
}

interface CDPSession {
  wsEndpoint: string;
  createdAt: string;
}

// --- Public types ---

export interface ZapInfo {
  id: string;
  title: string;
  status: string; // "on" | "off" | "draft" | "error"
  lastRun?: string;
  stepCount?: number;
  updatedAt?: string;
}

export interface ZapRun {
  id: string;
  zapId: string;
  zapTitle: string;
  status: string; // "success" | "error" | "halted" | "filtered" | "delayed"
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
}

export interface ZapRunDetail {
  id: string;
  zapId: string;
  zapTitle: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  steps: Array<{
    name: string;
    app: string;
    status: string;
    errorMessage?: string;
    inputData?: Record<string, unknown>;
    outputData?: Record<string, unknown>;
  }>;
}

export interface ScreenshotOptions {
  filename?: string;
  fullPage?: boolean;
}

export class ZapierBrowserClient {
  private config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private debug: boolean;

  constructor(options?: { debug?: boolean }) {
    this.config = this.loadConfig();
    this.debug = options?.debug ?? false;

    // Ensure directories exist
    for (const dir of [SESSION_DIR, SCREENSHOT_DIR]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  // ============================================
  // INTERNAL: Config & Session
  // ============================================

  private loadConfig(): Config {
    if (!existsSync(CONFIG_PATH)) {
      throw new Error(`Config file not found at ${CONFIG_PATH}`);
    }
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }

  private getCredentials(): { email: string; password: string } {
    if (this.config.zapier?.email && this.config.zapier?.password) {
      return this.config.zapier;
    }
    throw new Error(
      "Zapier credentials not found in config.json. " +
      'Add a "zapier" section with "email" and "password" fields.'
    );
  }

  private saveCDPSession(wsEndpoint: string): void {
    writeFileSync(
      CDP_SESSION_PATH,
      JSON.stringify({ wsEndpoint, createdAt: new Date().toISOString() } as CDPSession)
    );
  }

  private loadCDPSession(): CDPSession | null {
    if (!existsSync(CDP_SESSION_PATH)) return null;
    try {
      return JSON.parse(readFileSync(CDP_SESSION_PATH, "utf-8"));
    } catch {
      return null;
    }
  }

  // ============================================
  // INTERNAL: Browser Lifecycle
  // ============================================

  /**
   * Ensures a browser is running and returns the page.
   *
   * Strategy:
   * 1. Try CDP reconnection (fast path for same-process reuse)
   * 2. Try storageState restoration (primary persistence — cookies/localStorage)
   * 3. Fall back to fresh browser launch
   */
  private async ensureBrowser(): Promise<Page> {
    // Fast path: CDP reconnection
    const cdpSession = this.loadCDPSession();
    if (cdpSession && !this.browser) {
      try {
        this.browser = await chromium.connectOverCDP(cdpSession.wsEndpoint);
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
          this.context = contexts[0];
          const pages = this.context.pages();
          if (pages.length > 0) {
            this.page = pages[0];
            return this.page;
          }
        }
      } catch {
        // CDP session expired, clean up
        this.cleanupSessionFiles();
      }
    }

    if (this.page) return this.page;

    // Launch new browser
    this.browser = await chromium.launch({
      headless: !this.debug,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
      ],
    });

    // Create context — restore storageState if available
    const contextOptions: Record<string, unknown> = {
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };

    if (existsSync(STORAGE_STATE_PATH)) {
      contextOptions.storageState = STORAGE_STATE_PATH;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    // Save CDP endpoint for fast-path reconnection
    const wsEndpoint = (this.browser as any)?.wsEndpoint?.() as string | undefined;
    if (wsEndpoint) {
      this.saveCDPSession(wsEndpoint);
    }

    return this.page;
  }

  private cleanupSessionFiles(): void {
    for (const path of [CDP_SESSION_PATH, STORAGE_STATE_PATH]) {
      if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Saves the current browser context's storageState to tmpfs.
   * This captures cookies + localStorage for session persistence.
   */
  private async saveStorageState(): Promise<void> {
    if (this.context) {
      await this.context.storageState({ path: STORAGE_STATE_PATH });
    }
  }

  // ============================================
  // INTERNAL: Authentication
  // ============================================

  /**
   * Validates whether the current session is still authenticated
   * by hitting a lightweight internal endpoint.
   */
  private async isSessionValid(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const response = await this.page.request.get(`${ZAPIER_BASE}${API.me}`, {
        headers: { Accept: "application/json" },
      });
      return response.ok();
    } catch {
      return false;
    }
  }

  /**
   * Ensures we're logged in. Strategy:
   * 1. Check if current session is valid via API
   * 2. If not, perform browser-based login
   * 3. Save storageState after successful login
   */
  async ensureLoggedIn(): Promise<void> {
    const page = await this.ensureBrowser();

    // Check existing session
    if (await this.isSessionValid()) {
      if (this.debug) console.error("[debug] Session valid, skipping login");
      return; // Already authenticated
    }

    if (this.debug) console.error("[debug] Session invalid, starting login flow...");
    // Session invalid — need to login
    const creds = this.getCredentials();

    await page.goto(ZAPIER_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    // Screenshot login page
    const loginScreenshot = `${SCREENSHOT_DIR}/zapier-login-${Date.now()}.png`;
    await page.screenshot({ path: loginScreenshot, fullPage: true });

    // Fill email
    const emailSelectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input[id="email"]',
      'input[placeholder*="email" i]',
    ];

    let emailField = null;
    for (const selector of emailSelectors) {
      try {
        emailField = await page.waitForSelector(selector, { timeout: 8000 });
        if (emailField) break;
      } catch { continue; }
    }

    if (!emailField) {
      const errorScreenshot = `${SCREENSHOT_DIR}/zapier-login-error-no-email-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find email field. Screenshot: ${errorScreenshot}`);
    }

    // Dismiss cookie consent banner if present (can block button clicks)
    try {
      const cookieBtn = await page.$('button:has-text("Accept all cookies"), button:has-text("Accept All")');
      if (cookieBtn) {
        await cookieBtn.click();
        if (this.debug) console.error("[debug] Cookie banner dismissed");
        await page.waitForTimeout(1000);
      }
    } catch { /* ignore */ }

    await emailField.fill(creds.email);
    if (this.debug) console.error("[debug] Email filled");

    // Step 1: Click Continue to advance past email-only step
    // Zapier uses a multi-step login: email → Continue → password → Continue → auth code
    // IMPORTANT: Use :text-is() for exact match — :has-text() substring-matches
    // "Continue with Google" which appears earlier in the DOM
    const continueBtn = await page.$('button:text-is("Continue"), button[type="submit"]:not(:has-text("Continue with"))');
    if (continueBtn) {
      await continueBtn.click();
      if (this.debug) console.error("[debug] Continue button clicked");
    } else {
      // Fallback: press Enter to submit email
      await emailField.press("Enter");
      if (this.debug) console.error("[debug] Enter pressed on email field");
    }

    // Wait for page to transition to password step
    await page.waitForTimeout(4000);
    if (this.debug) {
      const afterContScreenshot = `${SCREENSHOT_DIR}/zapier-after-continue-${Date.now()}.png`;
      await page.screenshot({ path: afterContScreenshot, fullPage: true });
      console.error(`[debug] After continue, URL: ${page.url()}`);
    }

    // Step 2: Fill password — wait for the field to become visible
    let passwordField = null;
    try {
      passwordField = await page.waitForSelector('input[type="password"]', { state: "visible", timeout: 15000 });
      if (this.debug) console.error("[debug] Password field found");
    } catch {
      // Password field not found — might be on a different page layout
      const errorScreenshot = `${SCREENSHOT_DIR}/zapier-login-error-no-password-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find password field after clicking Continue. Screenshot: ${errorScreenshot}`);
    }

    await passwordField.fill(creds.password);
    if (this.debug) console.error("[debug] Password filled");

    // Step 3: Click Continue / Log in to submit password
    const loginBtn = await page.$('button:text-is("Continue"), button[type="submit"]:not(:has-text("Continue with")), button:has-text("Log in"), button:has-text("Sign in")');
    if (loginBtn) {
      await loginBtn.click();
      if (this.debug) console.error("[debug] Login button clicked");
    } else {
      // Fallback: press Enter
      await passwordField.press("Enter");
      if (this.debug) console.error("[debug] Enter pressed on password field");
    }

    // Wait for successful login — must navigate AWAY from login page
    // Negative lookahead excludes /app/login matching /app/
    // 60s timeout allows time for auth code entry in headful mode
    try {
      await page.waitForURL(/zapier\.com\/app\/(?!login)/, { timeout: 60000 });
    } catch {
      // Check for 2FA / CAPTCHA
      const pageUrl = page.url();
      const pageContent = await page.textContent("body").catch(() => "");

      if (
        pageContent?.toLowerCase().includes("two-factor") ||
        pageContent?.toLowerCase().includes("verification code") ||
        pageContent?.toLowerCase().includes("2fa") ||
        pageContent?.toLowerCase().includes("authentication code") ||
        pageContent?.toLowerCase().includes("verify your identity")
      ) {
        const tfaScreenshot = `${SCREENSHOT_DIR}/zapier-2fa-${Date.now()}.png`;
        await page.screenshot({ path: tfaScreenshot, fullPage: true });

        if (this.debug) {
          // In debug mode, wait for user to complete 2FA manually
          console.error("[debug] 2FA/auth code detected — complete it in the browser window. Waiting up to 120s...");
          try {
            await page.waitForURL(/zapier\.com\/app\/(?!login)/, { timeout: 120000 });
            await this.saveStorageState();
            return; // 2FA completed successfully
          } catch {
            throw new Error(`2FA not completed within 120s. Screenshot: ${tfaScreenshot}`);
          }
        }

        throw new Error(
          `2FA required. Screenshot: ${tfaScreenshot}. ` +
          "Run with --debug flag and complete 2FA manually, then retry."
        );
      }

      if (
        pageContent?.toLowerCase().includes("captcha") ||
        pageContent?.toLowerCase().includes("challenge") ||
        pageContent?.toLowerCase().includes("cloudflare")
      ) {
        const captchaScreenshot = `${SCREENSHOT_DIR}/zapier-captcha-${Date.now()}.png`;
        await page.screenshot({ path: captchaScreenshot, fullPage: true });
        throw new Error(
          `CAPTCHA/challenge detected. Screenshot: ${captchaScreenshot}. ` +
          "Run with --debug flag and solve manually."
        );
      }

      // Generic login failure
      const errorScreenshot = `${SCREENSHOT_DIR}/zapier-login-failed-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(
        `Login failed (stuck at ${pageUrl}). Screenshot: ${errorScreenshot}`
      );
    }

    // Login successful — save session
    if (this.debug) console.error(`[debug] Login successful, landed on: ${page.url()}`);
    await this.saveStorageState();
  }

  // ============================================
  // INTERNAL: API Helpers
  // ============================================

  /**
   * Makes an authenticated GET request to Zapier's internal API.
   * Uses page.request which automatically includes session cookies.
   */
  private async apiGet(path: string, params?: Record<string, string>): Promise<any> {
    await this.ensureLoggedIn();

    let url = `${ZAPIER_BASE}${path}`;
    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    if (this.debug) console.error(`[debug] GET ${path}`);
    const response = await this.page!.request.get(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok()) {
      const status = response.status();
      const body = await response.text().catch(() => "");

      // Session expired mid-request — clear state and throw
      if (status === 401 || status === 403) {
        this.cleanupSessionFiles();
        throw new Error(
          `Authentication failed (${status}). Session cleared — retry to re-login.`
        );
      }

      throw new Error(`API request failed: ${status} ${response.statusText()} — ${body.substring(0, 500)}`);
    }

    return response.json();
  }

  /**
   * Makes an authenticated PATCH request to Zapier's internal API.
   */
  private async apiPatch(path: string, data: Record<string, unknown>): Promise<any> {
    await this.ensureLoggedIn();

    const url = `${ZAPIER_BASE}${path}`;
    const response = await this.page!.request.patch(url, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      data,
    });

    if (!response.ok()) {
      const status = response.status();
      const body = await response.text().catch(() => "");

      if (status === 401 || status === 403) {
        this.cleanupSessionFiles();
        throw new Error(
          `Authentication failed (${status}). Session cleared — retry to re-login.`
        );
      }

      throw new Error(`API PATCH failed: ${status} ${response.statusText()} — ${body.substring(0, 500)}`);
    }

    return response.json();
  }

  // ============================================
  // PUBLIC: Zap Management — API-Based
  // ============================================

  /**
   * Lists all Zaps with their on/off/error status.
   *
   * Calls Zapier's internal API for structured JSON. Falls back to
   * DOM scraping if the API endpoint doesn't exist.
   */
  async listZaps(): Promise<ZapInfo[]> {
    try {
      const data = await this.apiGet(API.zaps);

      // Zapier's API may return { objects: [...] } or { results: [...] } or an array
      const zaps = data.objects || data.results || data.data || (Array.isArray(data) ? data : []);

      return zaps.map((z: any) => ({
        id: String(z.id),
        title: z.title || z.name || "Untitled",
        status: z.status || z.state || "unknown",
        lastRun: z.last_successful_run_date || z.last_run_at || z.updated_at,
        stepCount: z.step_count || z.steps?.length,
        updatedAt: z.updated_at,
      }));
    } catch (apiError: any) {
      // If API endpoint not found, fall back to page scraping
      if (apiError.message.includes("404") || apiError.message.includes("Not Found")) {
        return this.listZapsFromPage();
      }
      throw apiError;
    }
  }

  /**
   * DOM fallback for listing Zaps — navigates to /app/zaps and
   * intercepts XHR responses to capture the Zap list data.
   */
  private async listZapsFromPage(): Promise<ZapInfo[]> {
    await this.ensureLoggedIn();
    const page = this.page!;

    // Set up response interception to capture the Zap list API call
    let listener: ((response: any) => void) | null = null;
    const zapsPromise = new Promise<any[]>((resolve) => {
      const timeout = setTimeout(() => resolve([]), 15000);

      listener = async (response: any) => {
        const url = response.url();
        if (url.includes("/zap") && url.includes("api") && response.status() === 200) {
          try {
            const json = await response.json();
            const zaps = json.objects || json.results || json.data || (Array.isArray(json) ? json : null);
            if (zaps && zaps.length > 0) {
              clearTimeout(timeout);
              resolve(zaps);
            }
          } catch { /* not JSON, skip */ }
        }
      };
      page.on("response", listener);
    });

    await page.goto(ZAPIER_ZAPS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    const zaps = await zapsPromise;
    if (listener) page.off("response", listener);

    return zaps.map((z: any) => ({
      id: String(z.id),
      title: z.title || z.name || "Untitled",
      status: z.status || z.state || "unknown",
      lastRun: z.last_successful_run_date || z.last_run_at || z.updated_at,
      stepCount: z.step_count || z.steps?.length,
      updatedAt: z.updated_at,
    }));
  }

  /**
   * Views Zap run history. Optionally filtered by Zap ID.
   *
   * @param options.zapId - Filter to a specific Zap
   * @param options.limit - Max results (default: 25)
   */
  async viewHistory(options?: { zapId?: string; limit?: number }): Promise<ZapRun[]> {
    const params: Record<string, string> = {};
    if (options?.zapId) params.zap = options.zapId;
    if (options?.limit) params.limit = String(options.limit);

    try {
      const data = await this.apiGet(API.zapRuns, params);
      const runs = data.objects || data.results || data.data || (Array.isArray(data) ? data : []);

      return runs.map((r: any) => ({
        id: String(r.id),
        zapId: String(r.zap?.id || r.zap_id || ""),
        zapTitle: r.zap?.title || r.zap_title || "",
        status: r.status || "unknown",
        startedAt: r.start_time || r.started_at || r.created_at || "",
        finishedAt: r.end_time || r.finished_at,
        errorMessage: r.error_message || r.error?.message,
      }));
    } catch (apiError: any) {
      // Fall back to history page interception
      if (apiError.message.includes("404") || apiError.message.includes("Not Found")) {
        return this.viewHistoryFromPage(options);
      }
      throw apiError;
    }
  }

  /**
   * DOM fallback for viewing history — intercepts XHR on /app/history.
   */
  private async viewHistoryFromPage(options?: { zapId?: string; limit?: number }): Promise<ZapRun[]> {
    await this.ensureLoggedIn();
    const page = this.page!;

    let listener: ((response: any) => void) | null = null;
    const runsPromise = new Promise<any[]>((resolve) => {
      const timeout = setTimeout(() => resolve([]), 15000);

      listener = async (response: any) => {
        const url = response.url();
        if (
          (url.includes("run") || url.includes("history")) &&
          url.includes("api") &&
          response.status() === 200
        ) {
          try {
            const json = await response.json();
            const runs = json.objects || json.results || json.data || (Array.isArray(json) ? json : null);
            if (runs && runs.length > 0) {
              clearTimeout(timeout);
              resolve(runs);
            }
          } catch { /* not JSON */ }
        }
      };
      page.on("response", listener);
    });

    let url = ZAPIER_HISTORY_URL;
    if (options?.zapId) url += `?zap=${options.zapId}`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    const runs = await runsPromise;
    if (listener) page.off("response", listener);
    const limit = options?.limit || 25;

    return runs.slice(0, limit).map((r: any) => ({
      id: String(r.id),
      zapId: String(r.zap?.id || r.zap_id || ""),
      zapTitle: r.zap?.title || r.zap_title || "",
      status: r.status || "unknown",
      startedAt: r.start_time || r.started_at || r.created_at || "",
      finishedAt: r.end_time || r.finished_at,
      errorMessage: r.error_message || r.error?.message,
    }));
  }

  /**
   * Gets detailed information about a specific Zap run, including
   * step-by-step error details.
   */
  async viewError(runId: string): Promise<ZapRunDetail> {
    try {
      const data = await this.apiGet(API.zapRunDetail(runId));

      const steps = (data.steps || data.action_log || []).map((s: any) => ({
        name: s.title || s.action_type || s.name || "Unknown step",
        app: s.app || s.selected_api || "",
        status: s.status || "unknown",
        errorMessage: s.error_message || s.error?.message,
        inputData: s.input_data || s.input,
        outputData: s.output_data || s.output,
      }));

      return {
        id: String(data.id),
        zapId: String(data.zap?.id || data.zap_id || ""),
        zapTitle: data.zap?.title || data.zap_title || "",
        status: data.status || "unknown",
        startedAt: data.start_time || data.started_at || "",
        finishedAt: data.end_time || data.finished_at,
        steps,
      };
    } catch (apiError: any) {
      // Fall back to navigating to the run detail page
      if (apiError.message.includes("404") || apiError.message.includes("Not Found")) {
        return this.viewErrorFromPage(runId);
      }
      throw apiError;
    }
  }

  /**
   * DOM fallback for viewing run details — intercepts XHR on the run page.
   */
  private async viewErrorFromPage(runId: string): Promise<ZapRunDetail> {
    await this.ensureLoggedIn();
    const page = this.page!;

    let listener: ((response: any) => void) | null = null;
    const detailPromise = new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000);

      listener = async (response: any) => {
        const url = response.url();
        if (url.includes(runId) && response.status() === 200) {
          try {
            const json = await response.json();
            if (json.id || json.status) {
              clearTimeout(timeout);
              resolve(json);
            }
          } catch { /* not JSON */ }
        }
      };
      page.on("response", listener);
    });

    // Navigate to the run detail — Zapier URLs are like /app/history/run/{runId}
    await page.goto(`${ZAPIER_BASE}/app/history/run/${runId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(5000);

    const data = await detailPromise;
    if (listener) page.off("response", listener);

    if (!data) {
      // Last resort: extract from page text
      const screenshot = `${SCREENSHOT_DIR}/zapier-error-detail-${Date.now()}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      const text = await page.textContent("body").catch(() => "") || "";

      return {
        id: runId,
        zapId: "",
        zapTitle: "",
        status: "unknown",
        startedAt: "",
        steps: [{
          name: "Page content",
          app: "",
          status: "error",
          errorMessage: text.substring(0, 2000),
        }],
      };
    }

    const steps = (data.steps || data.action_log || []).map((s: any) => ({
      name: s.title || s.action_type || s.name || "Unknown step",
      app: s.app || s.selected_api || "",
      status: s.status || "unknown",
      errorMessage: s.error_message || s.error?.message,
      inputData: s.input_data || s.input,
      outputData: s.output_data || s.output,
    }));

    return {
      id: String(data.id),
      zapId: String(data.zap?.id || data.zap_id || ""),
      zapTitle: data.zap?.title || data.zap_title || "",
      status: data.status || "unknown",
      startedAt: data.start_time || data.started_at || "",
      finishedAt: data.end_time || data.finished_at,
      steps,
    };
  }

  // ============================================
  // PUBLIC: Zap Management — Actions (API or UI)
  // ============================================

  /**
   * Replays a failed Zap run.
   *
   * Tries PATCH/POST API first; falls back to navigating to
   * the run page and clicking the Replay button.
   */
  async replayRun(runId: string): Promise<{ success: boolean; message: string; screenshot?: string }> {
    await this.ensureLoggedIn();

    // Try API replay first
    try {
      const response = await this.page!.request.post(
        `${ZAPIER_BASE}${API.zapRunDetail(runId)}/replay`,
        { headers: { Accept: "application/json", "Content-Type": "application/json" } }
      );
      if (response.ok()) {
        return { success: true, message: `Run ${runId} replayed successfully via API.` };
      }
    } catch {
      // API replay not available, fall through to UI
    }

    // UI fallback: navigate and click Replay
    const page = this.page!;
    await page.goto(`${ZAPIER_BASE}/app/history/run/${runId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Look for Replay button
    const replaySelectors = [
      'button:has-text("Replay")',
      'button:has-text("Re-run")',
      'button:has-text("Retry")',
      '[data-testid*="replay"]',
      'a:has-text("Replay")',
    ];

    let clicked = false;
    for (const selector of replaySelectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          clicked = true;
          break;
        }
      } catch { continue; }
    }

    await page.waitForTimeout(3000);
    const screenshot = `${SCREENSHOT_DIR}/zapier-replay-${Date.now()}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });

    if (!clicked) {
      return {
        success: false,
        message: `Could not find Replay button for run ${runId}. See screenshot.`,
        screenshot,
      };
    }

    // Check for confirmation dialog
    const confirmBtn = await page.$('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("OK")');
    if (confirmBtn && await confirmBtn.isVisible()) {
      await confirmBtn.click();
      await page.waitForTimeout(2000);
    }

    const confirmScreenshot = `${SCREENSHOT_DIR}/zapier-replay-confirm-${Date.now()}.png`;
    await page.screenshot({ path: confirmScreenshot, fullPage: true });

    return {
      success: true,
      message: `Run ${runId} replay initiated via UI.`,
      screenshot: confirmScreenshot,
    };
  }

  /**
   * Toggles a Zap on or off.
   *
   * Tries PATCH API first; falls back to toggling from the
   * /app/zaps list view (lighter than opening the editor).
   */
  async toggleZap(
    zapId: string,
    enable: boolean
  ): Promise<{ success: boolean; message: string; screenshot?: string }> {
    await this.ensureLoggedIn();

    // Try API toggle first
    try {
      const data = await this.apiPatch(API.toggleZap(zapId), {
        status: enable ? "on" : "off",
      });
      return {
        success: true,
        message: `Zap ${zapId} ${enable ? "enabled" : "disabled"} via API.`,
      };
    } catch {
      // API toggle not available, fall through to UI
    }

    // UI fallback: navigate to zaps list and toggle
    const page = this.page!;
    await page.goto(ZAPIER_ZAPS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(5000);

    // Try to find the toggle for this specific Zap
    // Zapier's list shows toggles — we need to locate the right row
    const toggleSelectors = [
      `[data-zap-id="${zapId}"] input[type="checkbox"]`,
      `[data-zap-id="${zapId}"] [role="switch"]`,
      `[data-zap-id="${zapId}"] button[aria-label*="toggle" i]`,
    ];

    let toggled = false;
    for (const selector of toggleSelectors) {
      try {
        const toggle = await page.$(selector);
        if (toggle) {
          await toggle.click();
          toggled = true;
          break;
        }
      } catch { continue; }
    }

    // If data-zap-id selectors didn't work, try finding by intercepted list
    if (!toggled) {
      // Use evaluate to find toggle by row content
      toggled = await page.evaluate((targetId) => {
        // Find all toggle-like elements near the Zap ID
        const switches = document.querySelectorAll('[role="switch"], input[type="checkbox"]');
        for (const sw of switches) {
          const row = sw.closest('[data-testid], tr, [class*="row"], [class*="zap"]');
          if (row && row.innerHTML.includes(targetId)) {
            (sw as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, zapId);
    }

    await page.waitForTimeout(3000);
    const screenshot = `${SCREENSHOT_DIR}/zapier-toggle-${Date.now()}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });

    if (!toggled) {
      return {
        success: false,
        message: `Could not find toggle for Zap ${zapId}. See screenshot.`,
        screenshot,
      };
    }

    // Check for confirmation dialog (Zapier may ask to confirm turning off)
    const confirmBtn = await page.$('button:has-text("Turn off"), button:has-text("Confirm"), button:has-text("Yes")');
    if (confirmBtn && await confirmBtn.isVisible()) {
      await confirmBtn.click();
      await page.waitForTimeout(2000);
    }

    const confirmScreenshot = `${SCREENSHOT_DIR}/zapier-toggle-confirm-${Date.now()}.png`;
    await page.screenshot({ path: confirmScreenshot, fullPage: true });

    return {
      success: true,
      message: `Zap ${zapId} ${enable ? "enabled" : "disabled"} via UI.`,
      screenshot: confirmScreenshot,
    };
  }

  // ============================================
  // PUBLIC: API Discovery
  // ============================================

  /**
   * Discovers Zapier's internal API endpoints by navigating to key pages
   * and intercepting all XHR responses. Use with --debug for headful mode.
   *
   * Returns a map of captured API endpoints for documentation.
   */
  async discoverEndpoints(): Promise<Record<string, string[]>> {
    await this.ensureLoggedIn();
    const page = this.page!;
    const discovered: Record<string, string[]> = {};

    // Set up response listener
    const capturedUrls: string[] = [];
    const listener = (response: any) => {
      const url = response.url();
      if (url.includes("zapier.com/api") || url.includes("zapier.com/_next/data")) {
        capturedUrls.push(`${response.request().method()} ${url} → ${response.status()}`);
      }
    };
    page.on("response", listener);

    // Navigate to Zaps page
    await page.goto(ZAPIER_ZAPS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    discovered["zaps_page"] = [...capturedUrls];
    capturedUrls.length = 0;

    // Navigate to History page
    await page.goto(ZAPIER_HISTORY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    discovered["history_page"] = [...capturedUrls];
    capturedUrls.length = 0;

    page.off("response", listener);

    // Take screenshot of final state
    const screenshot = `${SCREENSHOT_DIR}/zapier-discovery-${Date.now()}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });

    return discovered;
  }

  // ============================================
  // PUBLIC: Utilities
  // ============================================

  /**
   * Takes a screenshot of the current browser state.
   */
  async takeScreenshot(options?: ScreenshotOptions): Promise<{ success: boolean; screenshot: string }> {
    const page = await this.ensureBrowser();

    const filename = options?.filename || `zapier-${Date.now()}.png`;
    const screenshotPath = `${SCREENSHOT_DIR}/${filename}`;

    await page.screenshot({
      path: screenshotPath,
      fullPage: options?.fullPage ?? false,
    });

    return { success: true, screenshot: screenshotPath };
  }

  /**
   * Closes browser session and clears all saved state.
   */
  async reset(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
      }

      this.cleanupSessionFiles();

      return { success: true, message: "Browser session closed and cleared." };
    } catch (error: any) {
      return { success: false, message: `Reset failed: ${error.message}` };
    }
  }
}

export default ZapierBrowserClient;
