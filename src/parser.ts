import type { Suite, Scenario } from "./types.ts";

/**
 * Count the number of steps in a scenario's prose.
 * Each non-empty line that reads like an instruction is a step.
 */
function countSteps(steps: string): number {
  return steps
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .length;
}

/**
 * Parse a .smoke.md file into a Suite with scenarios.
 *
 * Format:
 *   # Suite: Name
 *   ## Config
 *   Key: Value
 *   ## Scenario: Name
 *   Prose steps...
 */
export function parseSmokeFile(content: string, filePath: string): Suite {
  const lines = content.split("\n");

  let name = filePath;
  const config: Record<string, string> = {};
  const scenarios: Scenario[] = [];

  let currentSection: "none" | "config" | "scenario" = "none";
  let currentScenarioName = "";
  let currentScenarioLines: string[] = [];

  function flushScenario() {
    if (currentScenarioName) {
      const steps = currentScenarioLines.join("\n").trim();
      if (steps) {
        const stepCount = countSteps(steps);
        scenarios.push({ name: currentScenarioName, steps, stepCount });
      }
    }
    currentScenarioName = "";
    currentScenarioLines = [];
  }

  for (const line of lines) {
    // # Suite: Name
    const suiteMatch = line.match(/^#\s+Suite:\s*(.+)/);
    if (suiteMatch) {
      name = suiteMatch[1]!.trim();
      currentSection = "none";
      continue;
    }

    // ## Config
    if (/^##\s+Config\s*$/i.test(line)) {
      flushScenario();
      currentSection = "config";
      continue;
    }

    // ## Scenario: Name
    const scenarioMatch = line.match(/^##\s+Scenario:\s*(.+)/);
    if (scenarioMatch) {
      flushScenario();
      currentScenarioName = scenarioMatch[1]!.trim();
      currentSection = "scenario";
      continue;
    }

    // Any other ## heading ends the current section
    if (/^##\s+/.test(line)) {
      flushScenario();
      currentSection = "none";
      continue;
    }

    // Collect content based on section
    if (currentSection === "config") {
      const kvMatch = line.match(/^([^:]+):\s*(.+)/);
      if (kvMatch) {
        config[kvMatch[1]!.trim()] = kvMatch[2]!.trim();
      }
    } else if (currentSection === "scenario") {
      currentScenarioLines.push(line);
    }
  }

  flushScenario();

  if (scenarios.length === 0) {
    throw new Error(`No scenarios found in ${filePath}`);
  }

  return { name, config, scenarios, filePath };
}
