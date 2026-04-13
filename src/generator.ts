import { WebsterClient } from "./webster.ts";
import type { GenerateOptions } from "./types.ts";

/**
 * Generate a .smoke.md test file by watching the browser.
 *
 * Polls get_page_info to detect navigations and build a timeline.
 * Works on any browser (Safari, Chrome, Firefox) — no capture API needed.
 */
export async function generateFromWatch(options: GenerateOptions): Promise<string> {
  const webster = new WebsterClient(options.websterUrl);
  await webster.initialize();

  process.stderr.write(`\n  ● Watching browser — browse normally.\n`);
  process.stderr.write(`  Press Enter when done...\n\n`);

  const entries: WatchEntry[] = [];
  let lastUrl = "";
  let lastClickDetail = "";
  let watching = true;
  let lastInputTs = Date.now();

  // Navigation polling loop (no long-poll API for URL changes, so we poll)
  const navLoop = (async () => {
    while (watching) {
      try {
        const pageResult = await webster.call("get_page_info", {});
        const pageText = pageResult.content.find((c) => c.type === "text")?.text ?? "{}";
        const info = JSON.parse(pageText) as { url?: string; title?: string };

        if (info.url && info.url !== lastUrl) {
          lastUrl = info.url;
          entries.push({
            type: "navigation",
            url: info.url,
            title: info.title ?? "",
            timestamp: Date.now(),
          });
          process.stderr.write(`    → ${describeNav(info.url, info.title)}\n`);
        }
      } catch {
        // Webster might be momentarily unavailable during navigation
      }
      await Bun.sleep(1500);
    }
  })();

  // Input event long-poll loop — blocks until new click/change arrives, never misses.
  // Uses Webster's `waitFor: "new_events"` API with `types` filter and `minTimestamp`
  // catch-up semantics — no need to clear the buffer.
  const inputLoop = (async () => {
    while (watching) {
      try {
        const inputResult = await webster.call("get_input_log", {
          clear: false,
          types: ["click", "change"],
          minTimestamp: lastInputTs,
          waitFor: "new_events",
          waitTimeoutMs: 3000,
        });
        const inputText = inputResult.content.find((c) => c.type === "text")?.text ?? "[]";
        const events = JSON.parse(inputText) as Array<Record<string, unknown>>;

        for (const event of events) {
          const type = String(event.type ?? "");
          const el = event.element as Record<string, unknown> | undefined;
          const ts = (event.t as number) ?? Date.now();

          if (ts > lastInputTs) lastInputTs = ts;

          if (type === "click" && el) {
            const detail = describeClick(el);
            if (detail && detail !== lastClickDetail) {
              lastClickDetail = detail;
              entries.push({
                type: "click",
                detail,
                element: el,
                timestamp: ts,
              });
              process.stderr.write(`    → click: ${detail}\n`);
            }
          } else if (type === "change" && el) {
            const value = String(event.value ?? "").slice(0, 80);
            const fieldName = String(el.name ?? el.placeholder ?? el.ariaLabel ?? el.tag ?? "field");
            entries.push({
              type: "input",
              detail: `Typed "${value}" into ${fieldName}`,
              element: el,
              timestamp: ts,
            });
            process.stderr.write(`    → typed "${value}" into ${fieldName}\n`);
          }
        }
      } catch {
        // Transient; retry on next iteration
        await Bun.sleep(500);
      }
    }
  })();

  // Wait for Enter or SIGINT (Ctrl-C)
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    // Listen for Enter on stdin
    process.stdin.once("data", done);
    process.stdin.setRawMode?.(false);
    process.stdin.resume();

    // Also respond to SIGINT so Ctrl-C stops cleanly (and generates the test)
    const sigintHandler = () => {
      process.stderr.write("\n  (Ctrl-C received — stopping)\n");
      done();
    };
    process.once("SIGINT", sigintHandler);
  });

  watching = false;
  process.stdin.pause();
  await Promise.all([navLoop, inputLoop]);

  // Get a final page read for richer context
  let finalPageContent = "";
  try {
    const readResult = await webster.call("read_page", {});
    finalPageContent = readResult.content.find((c) => c.type === "text")?.text ?? "";
    // Truncate to avoid blowing up the prompt
    finalPageContent = finalPageContent.slice(0, 3000);
  } catch {
    // best effort
  }

  await webster.close();

  const navCount = entries.filter((e) => e.type === "navigation").length;
  const clickCount = entries.filter((e) => e.type === "click").length;
  const inputCount = entries.filter((e) => e.type === "input").length;
  process.stderr.write(`\n  ■ Stopped. Captured ${navCount} navigations, ${clickCount} clicks, ${inputCount} inputs.\n`);

  if (entries.length === 0) {
    process.stderr.write(`  No interactions detected. Did you browse in the connected browser?\n`);
    process.exit(1);
  }

  process.stderr.write(`  Generating test...\n\n`);
  return convertToSmokeTest(entries, finalPageContent, options.model);
}

/**
 * Generate a .smoke.md from an existing Webster capture session.
 * Requires Chrome (uses Debugger Protocol capture data).
 */
export async function generateFromCapture(
  captureId: string,
  options: GenerateOptions,
): Promise<string> {
  const webster = new WebsterClient(options.websterUrl);
  await webster.initialize();

  // Fetch capture summary
  const summaryResult = await webster.call("get_capture", { id: captureId });
  const summaryText = extractText(summaryResult);

  // Fetch page events
  const pageEvents = await webster.call("get_capture", {
    id: captureId,
    events: true,
    kind: "page",
  });
  const pageText = extractText(pageEvents);

  // Fetch input events
  const inputEvents = await webster.call("get_capture", {
    id: captureId,
    events: true,
    kind: "input",
  });
  const inputText = extractText(inputEvents);

  // Fetch console events (for error detection)
  const consoleEvents = await webster.call("get_capture", {
    id: captureId,
    events: true,
    kind: "console",
  });
  const consoleText = extractText(consoleEvents);

  await webster.close();

  // Build entries from capture data
  const entries = buildEntriesFromCapture(summaryText, pageText, inputText, consoleText);

  process.stderr.write(`  Captured ${entries.length} events. Generating test...\n\n`);
  return convertToSmokeTest(entries, "", options.model);
}

// ── Types ──

interface WatchEntry {
  type: "navigation" | "click" | "input" | "console_error";
  url?: string;
  title?: string;
  detail?: string;
  element?: Record<string, unknown>;
  timestamp: number;
}

// ── Watch-mode helpers ──

/**
 * Describe a navigation for the progress log — show hash if present.
 */
function describeNav(url: string, title?: string): string {
  try {
    const u = new URL(url);
    const hash = u.hash ? ` ${u.hash}` : "";
    return title ? `${title}${hash}` : `${u.pathname}${hash}`;
  } catch {
    return url;
  }
}

/**
 * Build a concise human-readable description of a clicked element.
 * Prefers: aria-label → text → testId → href → tag.
 */
function describeClick(el: Record<string, unknown>): string {
  const text = (el.text as string | undefined)?.trim();
  const ariaLabel = el.ariaLabel as string | undefined;
  const testId = el.testId as string | undefined;
  const href = el.href as string | undefined;
  const tag = (el.tag as string | undefined)?.toLowerCase() ?? "element";
  const role = el.role as string | undefined;

  if (ariaLabel) return `"${ariaLabel}" (${role ?? tag})`;
  if (text && text.length > 0 && text.length <= 60) return `"${text}" (${role ?? tag})`;
  if (testId) return `[${testId}] (${tag})`;
  if (href) {
    try {
      const u = new URL(href);
      return `${tag} → ${u.pathname}${u.hash}`;
    } catch {
      return `${tag} → ${href}`;
    }
  }
  return tag;
}

// ── Build entries from capture data ──

function buildEntriesFromCapture(
  summaryText: string,
  pageText: string,
  inputText: string,
  consoleText: string,
): WatchEntry[] {
  const entries: WatchEntry[] = [];

  // Parse page events (navigations)
  try {
    const events = JSON.parse(pageText);
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e.url) {
          entries.push({
            type: "navigation",
            url: e.url,
            title: e.title ?? "",
            timestamp: e.timestamp ?? 0,
          });
        }
      }
    }
  } catch { /* not JSON array */ }

  // Parse input events (clicks, typing)
  try {
    const events = JSON.parse(inputText);
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e.type === "click") {
          entries.push({
            type: "click",
            detail: e.text ?? e.selector ?? `(${e.x}, ${e.y})`,
            timestamp: e.timestamp ?? 0,
          });
        } else if (e.type === "keypress" || e.type === "input") {
          entries.push({
            type: "input",
            detail: e.value ?? e.data ?? "",
            timestamp: e.timestamp ?? 0,
          });
        }
      }
    }
  } catch { /* not JSON array */ }

  // Parse console events (errors)
  try {
    const events = JSON.parse(consoleText);
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e.level === "error") {
          entries.push({
            type: "console_error",
            detail: e.message ?? e.text ?? "",
            timestamp: e.timestamp ?? 0,
          });
        }
      }
    }
  } catch { /* not JSON array */ }

  // Sort by timestamp
  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

// ── Convert timeline to smoke test via Claude ──

async function convertToSmokeTest(
  entries: WatchEntry[],
  pageContent: string,
  model: string,
): Promise<string> {
  const prompt = buildConversionPrompt(entries, pageContent);

  // Save the raw timeline + prompt for debugging / retry
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.writeFile("/tmp/webster-test-last-prompt.txt", prompt);
  await fs.writeFile("/tmp/webster-test-last-timeline.json", JSON.stringify({ entries, pageContent }, null, 2));

  const cwd = path.resolve(import.meta.dirname, "..");

  const proc = Bun.spawn(
    [
      "claude",
      "--model", model,
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "3",
      "-p", prompt,
    ],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    process.stderr.write(`  ⚠ claude exited with code ${proc.exitCode}\n`);
    if (stderr) process.stderr.write(`    stderr: ${stderr.slice(0, 500)}\n`);
    if (stdout) process.stderr.write(`    stdout: ${stdout.slice(0, 500)}\n`);
    return `# Conversion failed\n\nclaude exited with code ${proc.exitCode}. See /tmp/webster-test-last-prompt.txt and /tmp/webster-test-last-timeline.json to retry.\n\nstderr:\n${stderr}\n`;
  }

  let result = "";
  try {
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    result = parsed.result ?? "";
    if (parsed.is_error) {
      process.stderr.write(`  ⚠ claude reported is_error=true\n`);
    }
  } catch (err) {
    process.stderr.write(`  ⚠ Could not parse claude output as JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`    stdout (first 300 chars): ${stdout.slice(0, 300)}\n`);
    result = stdout;
  }

  if (!result) {
    process.stderr.write(`  ⚠ claude returned empty result. Timeline saved to /tmp/webster-test-last-timeline.json\n`);
  }

  // Extract markdown — may be in a code fence
  const fenced = result.match(/```(?:markdown)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1]!.trim() : result.trim();
}

function buildConversionPrompt(entries: WatchEntry[], pageContent: string): string {
  // Extract base URL from first navigation
  const firstNav = entries.find((e) => e.type === "navigation");
  const baseUrl = firstNav?.url ?? "unknown";
  let domain = "unknown";
  try { domain = new URL(baseUrl).hostname; } catch { /* */ }

  const navCount = entries.filter((e) => e.type === "navigation").length;
  const clickCount = entries.filter((e) => e.type === "click").length;
  const inputCount = entries.filter((e) => e.type === "input").length;

  let msg = `Convert this observed browser session into a .smoke.md smoke test file.\n\n`;
  msg += `## Session\n`;
  msg += `- Base URL: ${baseUrl}\n`;
  msg += `- Domain: ${domain}\n`;
  msg += `- Navigations: ${navCount}, Clicks: ${clickCount}, Inputs: ${inputCount}\n\n`;

  msg += `## Observed User Actions (in order)\n\n`;
  msg += `This is the exact sequence of things the user did. Base your test ONLY on these actions — do not invent additional clicks or navigations from the page content.\n\n`;

  for (const entry of entries) {
    if (entry.type === "navigation") {
      msg += `- [navigation] ${entry.title || "(no title)"} — ${entry.url}\n`;
    } else if (entry.type === "click") {
      msg += `- [click] ${entry.detail}\n`;
    } else if (entry.type === "input") {
      msg += `- [input] ${entry.detail}\n`;
    } else if (entry.type === "console_error") {
      msg += `- [JS ERROR] ${entry.detail}\n`;
    }
  }

  if (pageContent) {
    msg += `\n## Final Page Content (truncated — for verification step ideas ONLY, not for inventing actions)\n\n`;
    msg += `\`\`\`\n${pageContent.slice(0, 2000)}\n\`\`\`\n`;
  }

  msg += `\n## Generate a .smoke.md file\n\n`;
  msg += `Rules:\n`;
  msg += `- Format: # Suite: <name>, ## Config with Base URL, ## Scenario: <name>, then prose steps\n`;
  msg += `- Write steps as natural language: "Navigate to...", "Click...", "Verify..."\n`;
  msg += `- Base the test ONLY on actions the user actually performed above. If they clicked "Cameras", put that in the test. If they didn't click "Media", do NOT add a Media step.\n`;
  msg += `- Use the element descriptors to write intent-based steps: prefer the element's text or aria-label over selectors — "Click the 'Cameras' link" not "Click a[href='#cameras']"\n`;
  msg += `- After each user action, add verification steps grounded in what the final page content suggests was visible\n`;
  msg += `- Group related actions into 1-3 logical scenarios\n`;
  msg += `- Add a final "No console errors" scenario that replays the same navigation path and checks for JS errors\n`;
  msg += `- Output ONLY the .smoke.md content — no explanation, no code fences around the whole file\n`;

  return msg;
}

// ── Helpers ──

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}
