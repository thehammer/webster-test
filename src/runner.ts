import { WebsterClient } from "./webster.ts";
import { parseSmokeFile } from "./parser.ts";
import { printReport, writeJsonReport } from "./reporter.ts";
import type { RunReport, ScenarioResult, RunOptions } from "./types.ts";

/**
 * Run all scenarios in a single .smoke.md file.
 */
export async function runSuiteFile(filePath: string, options: RunOptions): Promise<RunReport> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  // Parse
  const content = await fs.readFile(filePath, "utf-8");
  const suite = parseSmokeFile(content, filePath);

  console.log(`\n  Loading: ${suite.name} (${suite.scenarios.length} scenarios)`);
  console.log(`  Executor: ${options.executor}`);

  // For the api executor, we need a live Webster connection for tool proxying.
  // For the claude-code executor, Claude Code handles Webster natively via MCP.
  let webster: WebsterClient | null = null;
  let websterTools: Awaited<ReturnType<WebsterClient["listTools"]>> = [];

  if (options.executor === "api") {
    webster = new WebsterClient(options.websterUrl);
    try {
      await webster.initialize();
    } catch (err) {
      console.error(`\n  ✗ Could not connect to Webster at ${options.websterUrl}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      console.error(`    Is Webster running? The api executor requires a direct connection.\n`);
      process.exit(1);
    }
    websterTools = await webster.listTools();
    console.log(`  Webster connected — ${websterTools.length} tools available\n`);
  } else {
    // For claude-code executor, just do a quick health check
    try {
      const res = await fetch(`${options.websterUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "webster-test-probe", version: "0.1.0" } } }),
      });
      if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      console.log(`  Webster reachable at ${options.websterUrl}\n`);
    } catch (err) {
      console.error(`\n  ⚠ Webster health check failed at ${options.websterUrl}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      console.error(`    The claude-code executor connects via MCP — make sure Webster is running.\n`);
      // Don't exit — let claude-code try; the agent will surface the error
    }
  }

  // Run scenarios sequentially
  const results: ScenarioResult[] = [];
  const suiteStart = Date.now();

  for (const scenario of suite.scenarios) {
    // Start capture if recording (api executor only — claude-code agent handles its own capture)
    let captureSessionId: string | undefined;
    if (options.record && webster) {
      try {
        captureSessionId = await webster.startCapture(true);
      } catch {
        // capture is optional — don't fail the run
      }
    }

    // Print scenario header so streaming tool calls appear underneath
    process.stderr.write(`  ▸ ${scenario.name}\n`);

    let result: ScenarioResult;

    if (options.executor === "api") {
      const { executeScenario } = await import("./executor-api.ts");
      result = await executeScenario(
        scenario,
        suite.config,
        websterTools,
        webster!,
        options.model,
        options.timeout,
      );
    } else {
      const { executeScenario } = await import("./executor-claude-code.ts");
      result = await executeScenario(scenario, suite.config, {
        model: options.model,
        timeout: options.timeout,
      });
    }

    if (captureSessionId) {
      result.captureSessionId = captureSessionId;
      try {
        await webster!.stopCapture();
      } catch {
        // best effort
      }
    }

    results.push(result);
  }

  if (webster) await webster.close();

  // Build report
  const report: RunReport = {
    suite: suite.name,
    filePath: path.resolve(filePath),
    timestamp: new Date().toISOString(),
    model: options.model,
    executor: options.executor,
    scenarios: results,
    durationMs: Date.now() - suiteStart,
  };

  // Output
  printReport(report);

  // Write JSON report
  const sanitizedName = suite.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputDir = path.join("reports", `${dateStr}-${sanitizedName}`);
  const jsonPath = await writeJsonReport(report, outputDir);
  console.log(`  Report: ${jsonPath}\n`);

  return report;
}
