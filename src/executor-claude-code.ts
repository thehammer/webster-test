import path from "node:path";
import type { Scenario, ScenarioResult } from "./types.ts";

const AGENT_PATH = path.resolve(import.meta.dirname, "agent.md");

// Terminal formatting
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

/**
 * Execute a scenario by spawning a `claude` CLI subprocess with stream-json
 * output. We parse events as they arrive for real-time progress and to
 * preserve diagnostic info on timeout.
 */
export async function executeScenario(
  scenario: Scenario,
  config: Record<string, string>,
  options: { model: string; timeout: number },
): Promise<ScenarioResult> {
  const startTime = Date.now();
  const prompt = buildPrompt(scenario, config);

  const args = [
    "--agent", AGENT_PATH,
    "--model", options.model,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "50",
    "--permission-mode", "bypassPermissions",
    "-p", prompt,
  ];

  const proc = Bun.spawn(["claude", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Track progress from stream events
  const toolCalls: string[] = [];
  let lastToolName = "";
  let resultText = "";
  let isError = false;
  let timedOut = false;
  let numTurns = 0;

  // Timeout handler
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeout);

  try {
    // Read stdout as streaming JSONL
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const event = JSON.parse(line);
          processEvent(event, toolCalls, scenario.name, (name) => { lastToolName = name; });

          // Capture the final result
          if (event.type === "result") {
            resultText = event.result ?? "";
            isError = event.is_error ?? false;
            numTurns = event.num_turns ?? 0;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const durationMs = Date.now() - startTime;

  // ── Build result ──

  if (timedOut) {
    const lastAction = lastToolName ? `last tool: ${lastToolName}` : "no tool calls recorded";
    const progress = toolCalls.length > 0
      ? `\n    Tool calls before timeout:\n${toolCalls.map(t => `      ${t}`).join("\n")}`
      : "";
    return failResult(
      scenario.name,
      `Timeout after ${options.timeout / 1000}s (${lastAction}, ${numTurns} turns)${progress}`,
      durationMs,
      "timeout",
    );
  }

  if (isError) {
    return failResult(scenario.name, `Claude error: ${resultText}`, durationMs, "claude_error");
  }

  if (!resultText) {
    return failResult(scenario.name, "Agent produced no output", durationMs, "no_output");
  }

  // Debug: show raw result text when parsing fails
  const result = parseAgentResult(resultText, scenario.name, durationMs);
  if (result.error) {
    process.stderr.write(`    ${YELLOW}⚠ Raw result text:${RESET}\n    ${resultText.slice(0, 500)}\n`);
  }
  return result;
}

// ── Process a single stream-json event ──

function processEvent(
  event: Record<string, unknown>,
  toolCalls: string[],
  scenarioName: string,
  setLastTool: (name: string) => void,
): void {
  // Tool use events — the agent is calling a Webster tool
  if (event.type === "assistant") {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;

    for (const block of content) {
      if (block.type === "tool_use") {
        const rawName = String(block.name ?? "");

        // Skip non-Webster tools (ToolSearch, etc.) — just infrastructure noise
        if (!rawName.startsWith("mcp__webster__")) continue;

        const name = rawName.replace("mcp__webster__", "");
        const input = block.input as Record<string, unknown> | undefined;

        // Build a concise description of the tool call
        let detail = name;
        if (input) {
          if (input.url) detail += ` ${input.url}`;
          else if (input.selector) detail += ` "${input.selector}"`;
          else if (input.text) detail += ` "${String(input.text).slice(0, 40)}"`;
          else if (input.ref) detail += ` ref=${input.ref}`;
        }

        toolCalls.push(detail);
        setLastTool(name);
        process.stderr.write(`    ${DIM}→ ${detail}${RESET}\n`);
      }
    }
  }
}

// ── Build the prompt ──

function buildPrompt(scenario: Scenario, config: Record<string, string>): string {
  let msg = `## Scenario: ${scenario.name}\n\n`;

  if (Object.keys(config).length > 0) {
    msg += "### Context\n";
    for (const [key, value] of Object.entries(config)) {
      msg += `- ${key}: ${value}\n`;
    }
    msg += "\n";
  }

  // Number the steps so the agent can reference them
  const stepLines = scenario.steps.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  msg += "### Steps\n\n";
  stepLines.forEach((line, i) => {
    msg += `${i + 1}. ${line}\n`;
  });

  msg += `\n---\n`;
  msg += `Execute these ${scenario.stepCount} steps now. After executing, output ONLY this template with your values filled in:\n\n`;
  msg += `{"status":"___","summary":"___","adaptations":[___],"failures":[___],"steps_completed":___,"steps_total":${scenario.stepCount}}\n\n`;
  msg += `Rules for filling in the template:\n`;
  msg += `- status: "passed" if ALL ${scenario.stepCount} steps succeeded, "failed" if ANY step failed\n`;
  msg += `- summary: one sentence about what happened (NEVER empty)\n`;
  msg += `- steps_completed: number from 0 to ${scenario.stepCount}\n`;
  msg += `- steps_total: always ${scenario.stepCount}\n`;

  return msg;
}

// ── Parse the JSON result block from agent text ──

function parseAgentResult(text: string, scenarioName: string, durationMs: number): ScenarioResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenced ? fenced[1]! : text.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    const match = text.match(/\{[\s\S]*"status"[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return failResult(scenarioName, `Could not parse agent result from: ${text.slice(0, 300)}`, durationMs, "parse_error");
      }
    } else {
      return failResult(scenarioName, `Agent did not output a result JSON block`, durationMs, "no_result");
    }
  }

  // Handle nested "report_result" wrapper
  if (parsed.report_result && typeof parsed.report_result === "object") {
    parsed = parsed.report_result as Record<string, unknown>;
  }

  // Normalize status
  const rawStatus = String(parsed.status ?? "failed").toLowerCase();
  const status: ScenarioResult["status"] =
    rawStatus === "passed" || rawStatus === "pass" ? "passed" :
    rawStatus === "skipped" || rawStatus === "skip" ? "skipped" :
    "failed";

  return {
    scenario: scenarioName,
    status,
    summary: (parsed.summary as string) ?? "",
    adaptations: (parsed.adaptations as string[]) ?? [],
    failures: (parsed.failures as string[]) ?? [],
    stepsCompleted: (parsed.steps_completed as number) ?? 0,
    stepsTotal: (parsed.steps_total as number) ?? 0,
    durationMs,
    executor: "claude-code",
  };
}

function failResult(
  scenario: string,
  summary: string,
  durationMs: number,
  error: string,
): ScenarioResult {
  return {
    scenario,
    status: "failed",
    summary,
    adaptations: [],
    failures: [summary],
    stepsCompleted: 0,
    stepsTotal: 0,
    durationMs,
    error,
    executor: "claude-code",
  };
}
