// ── Test file structures ──

export interface Suite {
  name: string;
  config: Record<string, string>;
  scenarios: Scenario[];
  filePath: string;
}

export interface Scenario {
  name: string;
  steps: string; // raw prose — Claude interprets this, not us
  stepCount: number; // number of steps, counted by parser
}

// ── Scenario execution result ──

export interface ScenarioResult {
  scenario: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  adaptations: string[];
  failures: string[];
  stepsCompleted: number;
  stepsTotal: number;
  durationMs: number;
  captureSessionId?: string;
  error?: string; // runner-level error (timeout, API failure, etc.)
  executor?: "api" | "claude-code"; // which executor ran this
}

// ── Full run report ──

export interface RunReport {
  suite: string;
  filePath: string;
  timestamp: string;
  model: string;
  executor: "api" | "claude-code";
  scenarios: ScenarioResult[];
  durationMs: number;
}

// ── Webster MCP types (used by api executor) ──

export interface WebsterTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// ── CLI options ──

export type ExecutorType = "api" | "claude-code";

export interface RunOptions {
  record: boolean;
  model: string;
  websterUrl: string;
  timeout: number; // per-scenario timeout in ms
  executor: ExecutorType;
}

// ── Generate options ──

export interface GenerateOptions {
  model: string;
  websterUrl: string;
  output?: string; // output file path (default: stdout)
}
