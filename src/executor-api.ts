import Anthropic from "@anthropic-ai/sdk";
import type { WebsterClient } from "./webster.ts";
import type { WebsterTool, ScenarioResult, Scenario } from "./types.ts";

// executor: "api" — calls Anthropic SDK directly, proxies Webster tools through WebsterClient

// ── System prompt (embedded — no external file) ──

const SYSTEM_PROMPT = `You are a browser smoke test executor. Your job is to carry out test steps described in plain English by driving a real browser through Webster tools.

## How You Work

You receive a scenario: a set of steps and assertions written in prose. You execute each step by calling the appropriate Webster browser tools — navigate, click, type, read the page, check the console, take screenshots, etc.

## Adaptation Over Failure

When a step says "click the Submit button" but you see a button labeled "Save" — click it and note the adaptation. When a step says "navigate to the Settings page" but the link says "Preferences" — navigate there and note the adaptation. Your goal is to fulfill the **intent** of each step, not match exact words.

**Only fail a step when:**
- The page returns an error (4xx, 5xx, crash)
- The element or content genuinely does not exist after looking carefully
- An assertion is clearly false (e.g., "verify no JS errors" but errors exist in the console)
- The page is fundamentally broken or unresponsive

**Do NOT fail when:**
- Labels, names, or text are slightly different from what the test says
- Layout has changed but the functionality is there
- Something takes longer than expected but eventually loads

## Execution Rules

1. Execute steps sequentially — complete each one before moving to the next
2. Read the page after navigation — always verify you arrived where expected
3. Stay on-domain — don't navigate to external sites unless the step explicitly says to
4. Don't submit real data — unless the scenario explicitly says to fill in and submit a form
5. Use screenshots strategically — take one after each major step for the report
6. Check console when asked — use read_console to check for JS errors when a step asks about errors

## Output Contract

After completing all steps (or encountering an unrecoverable failure), you MUST call the report_result tool exactly once. Always call it, even on error.`;

// ── report_result pseudo-tool definition ──

const REPORT_RESULT_TOOL: Anthropic.Tool = {
  name: "report_result",
  description:
    "Report the final result of this test scenario. Call this exactly once when all steps are complete or when an unrecoverable failure occurs.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string",
        enum: ["passed", "failed", "skipped"],
        description: "Overall scenario result",
      },
      summary: {
        type: "string",
        description: "One sentence describing what happened",
      },
      adaptations: {
        type: "array",
        items: { type: "string" },
        description: "Things adapted to — label changes, layout differences, timing waits",
      },
      failures: {
        type: "array",
        items: { type: "string" },
        description: "Specific failures — errors found, elements missing, assertions violated",
      },
      steps_completed: {
        type: "number",
        description: "Number of steps successfully completed",
      },
      steps_total: {
        type: "number",
        description: "Total number of steps in the scenario",
      },
    },
    required: ["status", "summary", "adaptations", "failures", "steps_completed", "steps_total"],
  },
};

// ── Convert Webster tools to Anthropic tool format ──

function toAnthropicTools(websterTools: WebsterTool[]): Anthropic.Tool[] {
  return websterTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

// ── Build the user message for a scenario ──

function buildScenarioMessage(scenario: Scenario, config: Record<string, string>): string {
  let msg = `## Scenario: ${scenario.name}\n\n`;

  if (Object.keys(config).length > 0) {
    msg += "### Context\n";
    for (const [key, value] of Object.entries(config)) {
      msg += `- ${key}: ${value}\n`;
    }
    msg += "\n";
  }

  msg += "### Steps\n\n";
  msg += scenario.steps;

  return msg;
}

// ── Model alias resolution (API requires full model names) ──

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-5-20250514",
  opus: "claude-opus-4-20250514",
  haiku: "claude-haiku-4-20250514",
};

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// ── Execute a single scenario ──

export async function executeScenario(
  scenario: Scenario,
  config: Record<string, string>,
  websterTools: WebsterTool[],
  webster: WebsterClient,
  model: string,
  timeoutMs: number,
): Promise<ScenarioResult> {
  const startTime = Date.now();
  const client = new Anthropic();
  model = resolveModel(model);

  const tools: Anthropic.Tool[] = [...toAnthropicTools(websterTools), REPORT_RESULT_TOOL];
  const userMessage = buildScenarioMessage(scenario, config);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  // Tool-use loop with timeout
  const deadline = startTime + timeoutMs;
  let maxTurns = 50; // safety valve

  while (maxTurns-- > 0) {
    if (Date.now() > deadline) {
      return {
        scenario: scenario.name,
        status: "failed",
        summary: `Scenario timed out after ${timeoutMs / 1000}s`,
        adaptations: [],
        failures: ["Timeout exceeded"],
        stepsCompleted: 0,
        stepsTotal: 0,
        durationMs: Date.now() - startTime,
        error: "timeout",
        executor: "api",
      };
    }

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Collect all tool uses and text from this response
    const toolUses = response.content.filter(
      (block): block is Anthropic.ContentBlock & { type: "tool_use" } =>
        block.type === "tool_use",
    );

    // If no tool calls and stop reason is end_turn, Claude is done without report_result
    if (toolUses.length === 0 && response.stop_reason === "end_turn") {
      return {
        scenario: scenario.name,
        status: "failed",
        summary: "Claude ended without calling report_result",
        adaptations: [],
        failures: ["No report_result call"],
        stepsCompleted: 0,
        stepsTotal: 0,
        durationMs: Date.now() - startTime,
        error: "no_report",
        executor: "api",
      };
    }

    // Process tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      // Check for report_result — this terminates the loop
      if (toolUse.name === "report_result") {
        const input = toolUse.input as Record<string, unknown>;
        return {
          scenario: scenario.name,
          status: (input.status as ScenarioResult["status"]) ?? "failed",
          summary: (input.summary as string) ?? "",
          adaptations: (input.adaptations as string[]) ?? [],
          failures: (input.failures as string[]) ?? [],
          stepsCompleted: (input.steps_completed as number) ?? 0,
          stepsTotal: (input.steps_total as number) ?? 0,
          durationMs: Date.now() - startTime,
          executor: "api",
        };
      }

      // Proxy to Webster
      try {
        const result = await webster.call(toolUse.name, toolUse.input as Record<string, unknown>);
        const text = result.content
          .map((c) => c.text ?? `[${c.type}: ${c.mimeType ?? "binary"}]`)
          .join("\n");

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: text,
          is_error: result.isError ?? false,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Webster error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    // Add assistant response + tool results to conversation
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Exhausted max turns
  return {
    scenario: scenario.name,
    status: "failed",
    summary: `Scenario exceeded maximum turns (50)`,
    adaptations: [],
    failures: ["Max turns exceeded"],
    stepsCompleted: 0,
    stepsTotal: 0,
    durationMs: Date.now() - startTime,
    error: "max_turns",
    executor: "api",
  };
}
