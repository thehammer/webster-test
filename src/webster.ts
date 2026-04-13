import type { WebsterTool, McpToolCallResult } from "./types.ts";

/**
 * Lightweight MCP Streamable HTTP client for Webster.
 *
 * Webster returns SSE (text/event-stream) responses. Each response contains
 * one or more `event: message` frames with JSON-RPC payloads in the `data:` lines.
 */
export class WebsterClient {
  private sessionId: string | null = null;
  private baseUrl: string;

  constructor(baseUrl: string = "http://localhost:3456") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Initialize MCP session. */
  async initialize(): Promise<void> {
    const res = await this.rawPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "webster-test", version: "0.1.0" },
      },
    });

    this.sessionId = res.headers.get("mcp-session-id");
    if (!this.sessionId) {
      throw new Error("Webster did not return a session ID");
    }

    const body = await this.parseSSE(res);
    if (body.error) {
      throw new Error(`Webster initialize error: ${body.error.message}`);
    }

    // Send initialized notification (fire-and-forget, no response expected)
    await this.rawPost(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      this.sessionId,
    );
  }

  /** Fetch available tools from Webster. */
  async listTools(): Promise<WebsterTool[]> {
    const body = await this.request("tools/list", {});
    return body.result?.tools ?? [];
  }

  /** Call a Webster tool and return the result. */
  async call(tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const body = await this.request("tools/call", { name: tool, arguments: args });

    if (body.error) {
      return {
        content: [{ type: "text", text: `Error: ${body.error.message}` }],
        isError: true,
      };
    }

    return body.result as McpToolCallResult;
  }

  /** Start a Webster capture session. */
  async startCapture(recordFrames: boolean = false): Promise<string> {
    const result = await this.call("start_capture", {
      ...(recordFrames && { recordFrames: true }),
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    const match = text.match(/capture[_ ]?(?:id|session)?[:\s]*([a-zA-Z0-9_-]+)/i);
    return match?.[1] ?? "unknown";
  }

  /** Stop the active capture session. */
  async stopCapture(): Promise<void> {
    await this.call("stop_capture", {});
  }

  /** Close the MCP session. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    this.sessionId = null;
  }

  // ── Internal ──

  private nextId = 2;

  private async rawPost(body: Record<string, unknown>, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    return fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  /** Parse an SSE response to extract the JSON-RPC message. */
  private async parseSSE(res: Response): Promise<any> {
    const contentType = res.headers.get("content-type") ?? "";

    // If server returns plain JSON, parse directly
    if (contentType.includes("application/json")) {
      return res.json();
    }

    // Parse SSE: look for `data:` lines
    const text = await res.text();
    const lines = text.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const json = line.slice(6).trim();
        if (json) {
          return JSON.parse(json);
        }
      }
    }

    throw new Error(`Could not parse Webster response: ${text.slice(0, 200)}`);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.sessionId) {
      throw new Error("WebsterClient not initialized — call initialize() first");
    }

    const res = await this.rawPost(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      },
      this.sessionId,
    );

    return this.parseSSE(res);
  }
}
