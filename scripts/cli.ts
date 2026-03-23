#!/usr/bin/env npx tsx
/**
 * Zapier CLI
 *
 * Combined CLI for Zapier MCP actions and Zap management.
 *
 * MCP commands (list-tools, list-actions, execute): use the Zapier MCP
 * server for AI action execution.
 *
 * Management reads (list-zaps, view-history, view-error, view-zap): use
 * the headless API client (no Chromium) with browser fallback.
 *
 * Management writes (replay-run, toggle-zap): try API client first,
 * fall back to browser automation if CSRF or other issues.
 *
 * Browser-only (discover-endpoints, screenshot, reset): always use browser.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { ZapierMCPClient } from "./mcp-client.js";
import { ZapierBrowserClient, type ZapInfo, type ZapRun, type ZapRunDetail } from "./zapier-browser-client.js";
import { ZapierApiClient, SessionExpiredError, ZAPIER_API_PATHS } from "./zapier-api-client.js";

// Detect --debug flag from process.argv (before runCli consumes args)
const DEBUG = process.argv.includes("--debug");

// --- Types for view-zap ---

interface ZapStep {
  position: number;
  app: string;
  actionType: string;
  actionName: string;
  inputs: Record<string, unknown>;
}

interface ZapDetail {
  id: string;
  title: string;
  status: string;
  steps: ZapStep[];
}

/**
 * Combined client that lazily initializes MCP, API, or browser clients
 * depending on which commands are used.
 *
 * Priority: API client (no browser) → browser fallback.
 * MCP commands never touch the browser or API client.
 */
class ZapierCombinedClient {
  private _mcpClient: ZapierMCPClient | null = null;
  private _apiClient: ZapierApiClient | null = null;
  private _browserClient: ZapierBrowserClient | null = null;

  /** Lazy: only connect MCP when an MCP command runs. */
  async getMcpClient(): Promise<ZapierMCPClient> {
    if (!this._mcpClient) {
      this._mcpClient = new ZapierMCPClient();
      await this._mcpClient.connect();
    }
    return this._mcpClient;
  }

  /**
   * Lazy: creates a headless API client using storageState.
   * If no session exists or it's expired, triggers browser login first.
   */
  async getApiClient(): Promise<ZapierApiClient> {
    if (!this._apiClient) {
      this._apiClient = new ZapierApiClient({ debug: DEBUG });
      try {
        await this._apiClient.connect();
        if (!(await this._apiClient.isSessionValid())) {
          throw new SessionExpiredError("Session expired");
        }
      } catch {
        // No session or expired — browser login first
        if (DEBUG) console.error("[combined] No valid session, triggering browser login...");
        const browser = this.getBrowserClient();
        await browser.ensureLoggedIn();
        // Reconnect API client with fresh storageState
        await this._apiClient.reconnect();
      }
    }
    return this._apiClient;
  }

  /** Lazy: only launch browser when a browser-only command runs. */
  getBrowserClient(): ZapierBrowserClient {
    if (!this._browserClient) {
      this._browserClient = new ZapierBrowserClient({ debug: DEBUG });
    }
    return this._browserClient;
  }

  /** Clean up all active clients. Called by runCli's finally block. */
  async disconnect(): Promise<void> {
    if (this._mcpClient) {
      await this._mcpClient.disconnect();
    }
    if (this._apiClient) {
      await this._apiClient.dispose();
    }
    if (this._browserClient) {
      await this._browserClient.reset();
    }
  }
}

/**
 * Wraps an API client call with browser fallback.
 * On SessionExpiredError: triggers browser login, reconnects API client, retries.
 * On other errors (404, etc.): falls through to browser fallback function.
 */
async function withApiFallback<T>(
  client: ZapierCombinedClient,
  apiFn: (api: ZapierApiClient) => Promise<T>,
  browserFallbackFn: () => Promise<T>,
): Promise<T> {
  try {
    const api = await client.getApiClient();
    return await apiFn(api);
  } catch (err: any) {
    if (err instanceof SessionExpiredError) {
      // Re-login and retry once
      if (DEBUG) console.error("[fallback] Session expired, re-authenticating...");
      const browser = client.getBrowserClient();
      await browser.ensureLoggedIn();
      const api = await client.getApiClient();
      await api.reconnect();
      try {
        return await apiFn(api);
      } catch {
        // Still failing — fall through to browser
      }
    }

    if (DEBUG) console.error(`[fallback] API failed (${err.message}), using browser...`);
    return browserFallbackFn();
  }
}

// ============================================
// Commands
// ============================================

const commands = {
  // --- MCP commands (unchanged) ---

  "list-tools": createCommand(
    z.object({}),
    async (_args, client: ZapierCombinedClient) => {
      const mcp = await client.getMcpClient();
      const tools = await mcp.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available Zapier MCP actions (raw)"
  ),

  "list-actions": createCommand(
    z.object({}),
    async (_args, client: ZapierCombinedClient) => {
      const mcp = await client.getMcpClient();
      return mcp.listAvailableActions();
    },
    "List MCP actions with parameter details"
  ),

  "execute": createCommand(
    z.object({
      action: z.string().min(1).describe("Action/tool name to execute"),
      params: z.string().optional().describe("JSON parameters for the action"),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { action, params: paramsJson } = args as { action: string; params?: string };
      let params: Record<string, unknown> = {};
      if (paramsJson) {
        try {
          params = JSON.parse(paramsJson);
        } catch {
          throw new Error("--params must be valid JSON");
        }
      }
      const mcp = await client.getMcpClient();
      return mcp.executeAction(action, params);
    },
    "Execute a Zapier MCP action by name"
  ),

  // --- Management reads (API client with browser fallback) ---

  "list-zaps": createCommand(
    z.object({}),
    async (_args, client: ZapierCombinedClient) => {
      return withApiFallback(
        client,
        async (api) => {
          const data = await api.get(ZAPIER_API_PATHS.zaps);
          const zaps = data.objects || data.results || data.data || (Array.isArray(data) ? data : []);
          return zaps.map((z: any): ZapInfo => ({
            id: String(z.id),
            title: z.title || z.name || "Untitled",
            status: z.status || z.state || "unknown",
            lastRun: z.last_successful_run_date || z.last_run_at || z.updated_at,
            stepCount: z.step_count || z.steps?.length,
            updatedAt: z.updated_at,
          }));
        },
        async () => {
          const browser = client.getBrowserClient();
          return browser.listZaps();
        },
      );
    },
    "List all Zaps with on/off/error status"
  ),

  "view-history": createCommand(
    z.object({
      zapId: z.string().optional().describe("Filter to a specific Zap ID"),
      limit: cliTypes.limit(25, 100),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { zapId, limit } = args as { zapId?: string; limit?: number };
      const params: Record<string, string> = {};
      if (zapId) params.zap = zapId;
      if (limit) params.limit = String(limit);

      return withApiFallback(
        client,
        async (api) => {
          const data = await api.get(ZAPIER_API_PATHS.zapRuns, params);
          const runs = data.objects || data.results || data.data || (Array.isArray(data) ? data : []);
          return runs.map((r: any): ZapRun => ({
            id: String(r.id),
            zapId: String(r.zap?.id || r.zap_id || ""),
            zapTitle: r.zap?.title || r.zap_title || "",
            status: r.status || "unknown",
            startedAt: r.start_time || r.started_at || r.created_at || "",
            finishedAt: r.end_time || r.finished_at,
            errorMessage: r.error_message || r.error?.message,
          }));
        },
        async () => {
          const browser = client.getBrowserClient();
          return browser.viewHistory({ zapId, limit });
        },
      );
    },
    "View Zap run history (all or filtered by Zap)"
  ),

  "view-error": createCommand(
    z.object({
      runId: z.string().min(1).describe("Run ID to inspect"),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { runId } = args as { runId: string };

      return withApiFallback(
        client,
        async (api) => {
          const data = await api.get(ZAPIER_API_PATHS.zapRunDetail(runId));
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
          } as ZapRunDetail;
        },
        async () => {
          const browser = client.getBrowserClient();
          return browser.viewError(runId);
        },
      );
    },
    "View detailed error info for a failed run"
  ),

  "view-zap": createCommand(
    z.object({
      zapId: z.string().min(1).describe("Zap ID to inspect"),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { zapId } = args as { zapId: string };

      return withApiFallback<ZapDetail>(
        client,
        async (api) => {
          const data = await api.get(ZAPIER_API_PATHS.zapDetail(zapId));
          const nodes = data.nodes || data.steps || [];
          return {
            id: String(data.id),
            title: data.title || data.name || "Untitled",
            status: data.status || data.state || "unknown",
            steps: nodes.map((s: any, i: number): ZapStep => ({
              position: i + 1,
              app: s.app?.title || s.selected_api || s.app_title || "",
              actionType: s.type_of || s.action_type || s.type || "",
              actionName: s.title || s.action || s.label || "",
              inputs: s.params || s.meta || s.input_fields || {},
            })),
          };
        },
        async () => {
          // Fallback: get from list-zaps and filter (no step details available)
          const browser = client.getBrowserClient();
          const zaps = await browser.listZaps();
          const match = zaps.find((z) => z.id === zapId);
          if (!match) {
            throw new Error(`Zap ${zapId} not found`);
          }
          return {
            id: match.id,
            title: match.title,
            status: match.status,
            steps: [], // Step details not available via list fallback
          };
        },
      );
    },
    "View a Zap's configuration (steps, apps, field mappings)"
  ),

  // --- Management writes (API client with browser fallback) ---

  "replay-run": createCommand(
    z.object({
      runId: z.string().min(1).describe("Run ID to replay"),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { runId } = args as { runId: string };

      return withApiFallback(
        client,
        async (api) => {
          await api.post(`${ZAPIER_API_PATHS.zapRunDetail(runId)}/replay`);
          return { success: true, message: `Run ${runId} replayed successfully via API.` };
        },
        async () => {
          const browser = client.getBrowserClient();
          return browser.replayRun(runId);
        },
      );
    },
    "Replay a failed Zap run"
  ),

  "toggle-zap": createCommand(
    z.object({
      zapId: z.string().min(1).describe("Zap ID to toggle"),
      enable: z.preprocess(
        (val) => {
          if (val === true || val === "true") return true;
          if (val === false || val === "false") return false;
          return undefined;
        },
        z.boolean().describe("true to enable, false to disable")
      ),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { zapId, enable } = args as { zapId: string; enable: boolean };

      return withApiFallback(
        client,
        async (api) => {
          await api.patch(ZAPIER_API_PATHS.zapDetail(zapId), {
            status: enable ? "on" : "off",
          });
          return {
            success: true,
            message: `Zap ${zapId} ${enable ? "enabled" : "disabled"} via API.`,
          };
        },
        async () => {
          const browser = client.getBrowserClient();
          return browser.toggleZap(zapId, enable);
        },
      );
    },
    "Turn a Zap on or off"
  ),

  // --- Browser-only commands ---

  "discover-endpoints": createCommand(
    z.object({}),
    async (_args, client: ZapierCombinedClient) => {
      const browser = client.getBrowserClient();
      return browser.discoverEndpoints();
    },
    "Discover Zapier's internal API endpoints (run with --debug)"
  ),

  "screenshot": createCommand(
    z.object({
      filename: z.string().optional().describe("Screenshot filename (default: zapier-<timestamp>.png)"),
      fullPage: z.preprocess(
        (val) => {
          if (val === true || val === "true") return true;
          if (val === false || val === "false") return false;
          return undefined;
        },
        z.boolean().optional().describe("Capture full scrollable page")
      ),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { filename, fullPage } = args as { filename?: string; fullPage?: boolean };
      const browser = client.getBrowserClient();
      return browser.takeScreenshot({ filename, fullPage });
    },
    "Take screenshot of current browser page"
  ),

  "reset": createCommand(
    z.object({}),
    async (_args, client: ZapierCombinedClient) => {
      const browser = client.getBrowserClient();
      return browser.reset();
    },
    "Close browser and clear session"
  ),
};

// Run CLI
runCli(commands, ZapierCombinedClient, {
  programName: "zapier-cli",
  description: "Zapier actions + Zap management",
});
