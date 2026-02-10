/**
 * Zapier MCP Client
 *
 * MCP wrapper client for executing Zapier actions via HTTP transport.
 * Connects to Zapier's MCP server using Bearer token authentication.
 *
 * Key features:
 * - Dynamic action discovery from configured Zapier account
 * - Execute any exposed action with parameters
 * - List available actions with parameter schemas
 *
 * Actions are configured in Zapier's AI Actions interface.
 * Only actions exposed to MCP are available via this client.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    type: "http";
    url: string;
    apiKey: string;
  };
}

export class ZapierMCPClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /** Establishes connection to the Zapier MCP server via HTTP. */
  async connect(): Promise<void> {
    if (this.connected) return;

    // Create HTTP transport with Authorization header for Zapier MCP
    this.transport = new StreamableHTTPClientTransport(
      new URL(this.config.mcpServer.url),
      {
        requestInit: {
          headers: {
            "Authorization": `Bearer ${this.config.mcpServer.apiKey}`,
          },
        },
      }
    );

    this.client = new Client(
      { name: "zapier-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Closes the MCP server connection. */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ============================================
  // ACTION OPERATIONS
  // ============================================

  /** Lists all available Zapier actions exposed to MCP. */
  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Calls a Zapier action by tool name.
   *
   * @param name - Tool/action name
   * @param args - Action parameters
   * @returns Action result (parsed JSON or text)
   * @throws {Error} If action fails
   */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    await this.connect();

    const result = await this.client!.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;

    if (result.isError) {
      const errorContent = content.find((c) => c.type === "text");
      throw new Error(errorContent?.text || "Tool call failed");
    }

    const textContent = content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return content;
  }

  /**
   * Executes a Zapier action by name.
   *
   * Zapier provides dynamic tools based on your configured AI Actions.
   * Use listAvailableActions() to discover available actions first.
   *
   * @param toolName - The action tool name
   * @param params - Action parameters
   * @returns Action result
   */
  async executeAction(toolName: string, params: Record<string, any>): Promise<any> {
    return this.callTool(toolName, params);
  }

  /**
   * Lists all available actions with their parameter schemas.
   *
   * Provides a simplified view of available Zapier actions including
   * name, description, parameter definitions, and required fields.
   *
   * @returns Array of actions with parameter details
   */
  async listAvailableActions(): Promise<any[]> {
    const tools = await this.listTools();
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema?.properties || {},
      required: t.inputSchema?.required || [],
    }));
  }
}

export default ZapierMCPClient;
