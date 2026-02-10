#!/usr/bin/env npx tsx
/**
 * Zapier CLI
 *
 * Combined CLI for Zapier MCP actions and Zap management.
 *
 * MCP commands (list-tools, list-actions, execute): use the Zapier MCP
 * server for AI action execution.
 *
 * Management commands (list-zaps, view-history, view-error, replay-run,
 * toggle-zap): use browser automation for Zap visibility & control.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { ZapierMCPClient } from "./mcp-client.js";
import { ZapierBrowserClient } from "./zapier-browser-client.js";

// Detect --debug flag from process.argv (before runCli consumes args)
const DEBUG = process.argv.includes("--debug");

/**
 * Combined client that lazily initializes MCP or browser clients
 * depending on which commands are used. MCP commands never touch
 * the browser; browser commands never touch MCP.
 */
class ZapierCombinedClient {
  private _mcpClient: ZapierMCPClient | null = null;
  private _browserClient: ZapierBrowserClient | null = null;

  /** Lazy: only connect MCP when an MCP command runs. */
  async getMcpClient(): Promise<ZapierMCPClient> {
    if (!this._mcpClient) {
      this._mcpClient = new ZapierMCPClient();
      await this._mcpClient.connect();
    }
    return this._mcpClient;
  }

  /** Lazy: only launch browser when a management command runs. */
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
    if (this._browserClient) {
      await this._browserClient.reset();
    }
  }
}

// ============================================
// Commands
// ============================================

const commands = {
  // --- MCP commands (existing) ---

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

  // --- Management commands (new — browser-based) ---

  "list-zaps": createCommand(
    z.object({}),
    async (_args, client: ZapierCombinedClient) => {
      const browser = client.getBrowserClient();
      return browser.listZaps();
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
      const browser = client.getBrowserClient();
      return browser.viewHistory({ zapId, limit });
    },
    "View Zap run history (all or filtered by Zap)"
  ),

  "view-error": createCommand(
    z.object({
      runId: z.string().min(1).describe("Run ID to inspect"),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { runId } = args as { runId: string };
      const browser = client.getBrowserClient();
      return browser.viewError(runId);
    },
    "View detailed error info for a failed run"
  ),

  "replay-run": createCommand(
    z.object({
      runId: z.string().min(1).describe("Run ID to replay"),
    }),
    async (args, client: ZapierCombinedClient) => {
      const { runId } = args as { runId: string };
      const browser = client.getBrowserClient();
      return browser.replayRun(runId);
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
      const browser = client.getBrowserClient();
      return browser.toggleZap(zapId, enable);
    },
    "Turn a Zap on or off"
  ),

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
