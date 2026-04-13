import type { RunReport, ScenarioResult } from "./types.ts";

// ── Terminal formatting ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

function statusIcon(status: ScenarioResult["status"]): string {
  switch (status) {
    case "passed":
      return `${GREEN}✓${RESET}`;
    case "failed":
      return `${RED}✗${RESET}`;
    case "skipped":
      return `${DIM}○${RESET}`;
  }
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Print report to terminal ──

export function printReport(report: RunReport): void {
  const line = "─".repeat(50);

  console.log();
  console.log(`${BOLD}Webster Test — ${report.suite}${RESET}`);
  console.log(line);

  for (const result of report.scenarios) {
    const icon = statusIcon(result.status);
    const duration = `${DIM}(${formatDuration(result.durationMs)})${RESET}`;
    const name = result.scenario.padEnd(30);

    let extra = "";
    if (result.adaptations.length > 0) {
      extra += `  ${DIM}· adapted: ${result.adaptations[0]}${RESET}`;
    }
    if (result.failures.length > 0) {
      extra += `  ${RED}· ${result.failures[0]}${RESET}`;
    }
    if (result.error) {
      extra += `  ${RED}· ${result.error}${RESET}`;
    }

    console.log(`  ${icon}  ${name} ${duration}${extra}`);
  }

  console.log(line);

  const passed = report.scenarios.filter((r) => r.status === "passed").length;
  const failed = report.scenarios.filter((r) => r.status === "failed").length;
  const skipped = report.scenarios.filter((r) => r.status === "skipped").length;

  const parts: string[] = [];
  if (passed > 0) parts.push(`${GREEN}${passed} passed${RESET}`);
  if (failed > 0) parts.push(`${RED}${failed} failed${RESET}`);
  if (skipped > 0) parts.push(`${DIM}${skipped} skipped${RESET}`);
  parts.push(`${DIM}${formatDuration(report.durationMs)}${RESET}`);

  console.log(`  ${parts.join("  ·  ")}`);
  console.log();
}

// ── Write JSON report ──

export async function writeJsonReport(report: RunReport, outputDir: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  await fs.mkdir(outputDir, { recursive: true });

  const filename = path.join(outputDir, "report.json");
  await fs.writeFile(filename, JSON.stringify(report, null, 2));

  return filename;
}
