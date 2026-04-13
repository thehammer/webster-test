#!/usr/bin/env bun

import type { RunOptions, GenerateOptions } from "./types.ts";

const DEFAULTS = {
  model: "sonnet",
  websterUrl: "http://localhost:3456",
  timeout: 120_000,
  executor: "claude-code" as const,
};

function usage(): never {
  process.stdout.write(`
  webster-test — Natural language smoke tests with Claude + Webster

  Commands:
    run <file.smoke.md>                    Run a single test file
    run <directory>                        Run all .smoke.md files in a directory
    generate <capture-id>                  Generate a .smoke.md from a Webster capture
    generate --live                        Start a capture, browse, stop, then generate

  Run options:
    --executor <claude-code|api>           Executor (default: ${DEFAULTS.executor})
    --record                               Record Webster capture session (api executor only)
    --model <model>                        Claude model (default: ${DEFAULTS.model})
    --webster-url <url>                    Webster MCP endpoint (default: ${DEFAULTS.websterUrl})
    --timeout <ms>                         Per-scenario timeout in ms (default: ${DEFAULTS.timeout})

  Generate options:
    --model <model>                        Claude model for test generation (default: ${DEFAULTS.model})
    --webster-url <url>                    Webster MCP endpoint (default: ${DEFAULTS.websterUrl})
    -o, --output <file>                    Output file (default: stdout)
`);
  process.exit(1);
}

// ── Parse CLI args ──

const args = process.argv.slice(2);
const command = args[0];

if (!command || !["run", "generate"].includes(command)) {
  usage();
}

if (command === "run") {
  await handleRun(args.slice(1));
} else if (command === "generate") {
  await handleGenerate(args.slice(1));
}

// ── Run command ──

async function handleRun(args: string[]) {
  const { runSuiteFile } = await import("./runner.ts");

  const targets: string[] = [];
  const options: RunOptions = {
    record: false,
    model: DEFAULTS.model,
    websterUrl: DEFAULTS.websterUrl,
    timeout: DEFAULTS.timeout,
    executor: DEFAULTS.executor,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case "--record":
        options.record = true;
        break;
      case "--model":
        options.model = args[++i] ?? DEFAULTS.model;
        break;
      case "--webster-url":
        options.websterUrl = args[++i] ?? DEFAULTS.websterUrl;
        break;
      case "--timeout":
        options.timeout = parseInt(args[++i] ?? String(DEFAULTS.timeout), 10);
        break;
      case "--executor": {
        const val = args[++i];
        if (val !== "api" && val !== "claude-code") {
          process.stderr.write(`  Unknown executor: ${val}. Use "api" or "claude-code".\n\n`);
          usage();
        }
        options.executor = val;
        break;
      }
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`  Unknown option: ${arg}\n\n`);
          usage();
        }
        targets.push(arg);
    }
    i++;
  }

  if (targets.length === 0) {
    process.stderr.write("  No test file or directory specified.\n\n");
    usage();
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const files: string[] = [];
  for (const target of targets) {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) {
      process.stderr.write(`  Not found: ${target}\n`);
      process.exit(1);
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target);
      const smokeFiles = entries
        .filter((e) => e.endsWith(".smoke.md"))
        .map((e) => path.join(target, e))
        .sort();
      if (smokeFiles.length === 0) {
        process.stderr.write(`  No .smoke.md files found in ${target}\n`);
        process.exit(1);
      }
      files.push(...smokeFiles);
    } else {
      files.push(target);
    }
  }

  let hasFailure = false;
  for (const file of files) {
    const report = await runSuiteFile(file, options);
    if (report.scenarios.some((s) => s.status === "failed")) {
      hasFailure = true;
    }
  }
  process.exit(hasFailure ? 1 : 0);
}

// ── Generate command ──

async function handleGenerate(args: string[]) {
  const options: GenerateOptions = {
    model: DEFAULTS.model,
    websterUrl: DEFAULTS.websterUrl,
  };

  let captureId = "";
  let live = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case "--live":
        live = true;
        break;
      case "--model":
        options.model = args[++i] ?? DEFAULTS.model;
        break;
      case "--webster-url":
        options.websterUrl = args[++i] ?? DEFAULTS.websterUrl;
        break;
      case "-o":
      case "--output":
        options.output = args[++i];
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`  Unknown option: ${arg}\n\n`);
          usage();
        }
        captureId = arg;
    }
    i++;
  }

  if (live) {
    await handleLiveCapture(options);
  } else if (captureId) {
    await handleCaptureGenerate(captureId, options);
  } else {
    process.stderr.write("  Specify a capture ID or use --live\n\n");
    usage();
  }
}

async function handleCaptureGenerate(captureId: string, options: GenerateOptions) {
  const { generateFromCapture } = await import("./generator.ts");

  process.stderr.write(`  Generating test from capture: ${captureId}\n`);
  const result = await generateFromCapture(captureId, options);

  if (options.output) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(options.output, result + "\n");
    process.stderr.write(`  Written to: ${options.output}\n`);
  } else {
    process.stdout.write(result + "\n");
  }
}

async function handleLiveCapture(options: GenerateOptions) {
  const { generateFromWatch } = await import("./generator.ts");

  const result = await generateFromWatch(options);

  if (options.output) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(options.output, result + "\n");
    process.stderr.write(`  Written to: ${options.output}\n`);
  } else {
    process.stdout.write(result + "\n");
  }
}
