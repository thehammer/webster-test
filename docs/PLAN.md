# Webster Test — Design & Implementation Plan

## What This Is

A natural language smoke test framework powered by Claude and Webster. Tests are written in plain English markdown. At runtime, Claude reads the test file, drives a real browser via Webster, and produces a structured report — adapting intelligently to minor UI changes rather than breaking on them.

**Not a replacement for unit tests or Playwright.** The niche is scheduled smoke tests where the ROI of LLM adaptability is high: tests that would otherwise require constant maintenance as UIs evolve.

---

## Core Philosophy

- **Prose over selectors** — tests describe intent, not implementation
- **Adaptation is a feature** — Claude notes when it had to adapt (button label changed, section was renamed) rather than failing; the adaptation log is useful signal
- **Failure means genuinely broken** — not "the CSS class changed"
- **Capture everything** — every run produces a full Webster session recording (network, screenshots, console) for post-mortem review
- **Framework, not platform** — other repos drop in test files and run them; the framework stays out of the way

---

## Architecture

```
webster-test/
      ↕ CLI
  Test Runner (Bun/TypeScript)
      ↕ Anthropic SDK (tool use)
  Claude (claude-sonnet / claude-opus)
      ↕ MCP HTTP API (localhost:3456)
  Webster Server
      ↕ WebSocket
  Browser Extension → Real Browser
```

The runner is a thin orchestrator:
1. Parses the `.smoke.md` test file
2. Opens a Webster capture session
3. For each scenario, runs a Claude conversation with Webster tools
4. Handles tool calls by proxying them to Webster's MCP HTTP endpoint
5. Collects Claude's structured result + all adaptations
6. Stops capture, writes report, optionally exports video

Claude is the test executor. The runner doesn't interpret the test steps — Claude does.

---

## Directory Structure

```
webster-test/
  docs/
    PLAN.md                   # this file
  README.md
  package.json                # Bun project
  src/
    cli.ts                    # entry: `webster-test run <file>`
    runner.ts                 # core orchestrator: parse → execute → report
    claude.ts                 # Anthropic SDK client with Webster tool proxying
    webster.ts                # Webster MCP HTTP client (session management)
    parser.ts                 # .smoke.md file parser → structured scenarios
    reporter.ts               # result formatting, HTML report generation
    types.ts                  # shared types
  prompts/
    system.md                 # system prompt for test-running Claude sessions
    scenario.md               # per-scenario prompt template
  tests/
    framework.smoke.md        # meta: smoke test the framework itself
    google.smoke.md           # simple public-web sanity test (no auth needed)
  examples/
    maisie/
      dashboard.smoke.md
      devices.smoke.md
      cameras.smoke.md
  reports/                    # gitignored — local run output
```

---

## Test File Format (`.smoke.md`)

Plain markdown. No special syntax. Claude reads it as written.

```markdown
# Suite: Maisie Dashboard

## Config
Base URL: https://maisie.example.com
Auth: already authenticated (extension handles session cookies)

## Scenario: Dashboard loads
Navigate to the dashboard.
Verify the main status area is visible.
Verify at least one device is shown, whether online or offline.

## Scenario: Navigation works
From the dashboard, navigate to the devices section.
Verify a list of devices appears.
Navigate back to the dashboard.
Verify we're back at the main view.

## Scenario: No console errors
Navigate to the dashboard.
Open the camera view if one exists.
Verify no JavaScript errors occurred during these navigations.
```

### Format Rules
- `# Suite:` — top-level name for the test file
- `## Config` — optional key/value pairs passed to Claude as context
- `## Scenario:` — a named test case; each runs in isolation
- Everything else is plain prose steps and assertions
- No assertion syntax — Claude decides what "verify X" means and whether it passed

---

## The Runner

### CLI
```bash
bun run src/cli.ts run tests/google.smoke.md
bun run src/cli.ts run examples/maisie/dashboard.smoke.md --record
bun run src/cli.ts run examples/maisie/ --record   # run all in dir
```

### Execution Flow (per scenario)

1. Start Webster capture session (with `recordFrames` if `--record`)
2. Send Claude a conversation:
   - System prompt: role, tools available, output format contract
   - User message: the scenario steps as prose + config context
3. Handle the tool-use loop:
   - Claude calls Webster tools (navigate, click, read_page, screenshot, etc.)
   - Runner proxies each call to Webster's MCP HTTP endpoint
   - Returns results to Claude
4. Claude emits a final structured result via a `report_result` pseudo-tool
5. Stop capture, attach session ID to result

### Claude's Output Contract

Claude is instructed to end each scenario by calling a `report_result` tool:

```json
{
  "status": "passed" | "failed" | "skipped",
  "summary": "One-sentence description of what happened.",
  "adaptations": [
    "Button was labeled 'Continue' instead of 'Next' — clicked anyway",
    "Device list took ~4s to load — waited successfully"
  ],
  "failures": [
    "Camera feed section returned a 500 error"
  ],
  "steps_completed": 4,
  "steps_total": 4
}
```

`report_result` is defined as a tool in the system prompt but handled by the runner, not Webster. It terminates the scenario loop.

---

## Webster Integration

The runner implements a lightweight MCP HTTP client:

```typescript
class WebsterClient {
  private sessionId: string | null = null;

  async initialize(): Promise<void>   // POST /mcp, store session ID
  async call(tool: string, args: Record<string, unknown>): Promise<unknown>
  async startCapture(opts?: CaptureOptions): Promise<void>
  async stopCapture(): Promise<CaptureResult>
}
```

All Webster tools are passed to Claude as Anthropic tool definitions, generated dynamically by fetching `tools/list` from the MCP endpoint at startup. No hardcoded tool list — the runner always reflects whatever Webster currently exposes.

---

## Reporting

### Terminal output (during run)
```
Webster Test — Maisie Dashboard
────────────────────────────────────────
✓  Dashboard loads           (2.1s)
✓  Navigation works          (3.4s)  · adapted: "Devices" tab was labeled "Hardware"
✗  No console errors         (1.8s)  · TypeError: Cannot read properties of undefined
────────────────────────────────────────
2 passed, 1 failed  ·  capture: ~/.webster/test-runs/2026-04-12-maisie-dashboard/
```

### JSON report (`report.json`)
Machine-readable, stored alongside the capture session.

### HTML report (`report.html`)
Self-contained viewer. Per-scenario timeline with screenshots from the capture session, adaptation notes highlighted, failures expanded. Reuses the Webster replay viewer aesthetic.

---

## Example Test Suites

### `tests/google.smoke.md` (no auth required)
Validates that the framework can drive a real browser at all.

```markdown
# Suite: Google Search (Framework Sanity)

## Scenario: Basic search works
Navigate to google.com.
Search for "webster browser automation".
Verify search results appear.
Verify the results page loaded without error.
```

### `tests/framework.smoke.md` (meta-test)
Tests the framework's own reporting and adaptation detection. Requires Webster running and Chrome connected.

### `examples/maisie/dashboard.smoke.md`
Covers: dashboard load, status panel visibility, device count, no JS errors.

### `examples/maisie/devices.smoke.md`
Covers: device list, device detail view, status indicators.

### `examples/maisie/cameras.smoke.md`
Covers: camera feeds visible, no error states, feed loads within timeout.

---

## System Prompt Design

The system prompt is the key lever. It instructs Claude to:

1. **Act as a browser test executor** — not a general assistant
2. **Adapt before failing** — try reasonable alternatives before giving up; always note what was adapted
3. **Define failure correctly** — only fail if the core intent of the step is impossible (page errored, element genuinely absent, assertion is clearly false after looking carefully)
4. **End with `report_result`** — always, even on error
5. **Stay scoped** — don't navigate away from the test domain, don't submit forms with real data unless the scenario explicitly says to

Key guidance:
> When a step says "click the submit button" and you see a button labeled "Save", click it and note the adaptation. When a step says "verify the dashboard loads" and you see a dashboard-like page, it passes. When a step says "verify no JavaScript errors occurred" and you find errors in the console, it fails. Use judgment — the test describes intent, not implementation.

---

## How Other Projects Use This

1. Add `.smoke.md` files anywhere in their repo (suggested: `tests/smoke/`)
2. Run: `npx webster-test run tests/smoke/` (or `bun run /path/to/webster-test/src/cli.ts run`)
3. Requires a running Webster server (default: `localhost:3456`)

No config files required to get started.

### Optional: `webster-test.config.ts`
For projects that want defaults (base URL, model, setup steps):
```typescript
export default {
  baseUrl: "https://app.example.com",
  model: "claude-sonnet-4-5",
  webster: "http://localhost:3456",
  setup: "Log in as the test user before each scenario.",
};
```

---

## Implementation Phases

### Phase 1 — Working End-to-End
- [ ] Bun project setup, TypeScript config
- [ ] `src/types.ts` — Suite, Scenario, ScenarioResult, RunReport
- [ ] `src/webster.ts` — MCP HTTP client (initialize, call, start/stop capture)
- [ ] `src/parser.ts` — parse `.smoke.md` into Suite + Scenario[]
- [ ] `src/claude.ts` — Anthropic SDK with Webster tool proxying + `report_result` handler
- [ ] `prompts/system.md` — system prompt
- [ ] `src/reporter.ts` — terminal output + `report.json`
- [ ] `src/runner.ts` — orchestrator
- [ ] `src/cli.ts` — `run` command
- [ ] `tests/google.smoke.md` — first working test
- [ ] Prove it works against Maisie with `examples/maisie/dashboard.smoke.md`

### Phase 2 — Capture & Reporting
- [ ] `--record` flag (Webster frame capture)
- [ ] HTML report with screenshot timeline
- [ ] `examples/maisie/` full suite (devices, cameras)
- [ ] Adaptation notes highlighted in reports
- [ ] Graceful error handling (Webster not running, Claude API failure, timeout)

### Phase 3 — Framework Usability
- [ ] `webster-test.config.ts` support
- [ ] Run entire directory of test files
- [ ] `--model` CLI flag
- [ ] Exit codes suitable for CI
- [ ] README with usage docs for external projects
- [ ] Consider npm/jsr publish

---

## Open Questions

- **Auth handling** — examples assume the browser already has session cookies (realistic for scheduled runs on a dev machine). CI auth is out of scope for Phase 1.
- **Model choice** — Sonnet is faster/cheaper; Opus handles ambiguity better. Default to Sonnet, allow override.
- **Parallelism** — scenarios run sequentially within a suite (may share browser state intentionally). Multiple suites could run in parallel across tabs. Defer to Phase 3.
- **Notifications** — on scheduled runs, failures should notify somewhere. Out of scope; compose with external tooling.
- **Video export** — Webster supports frame recording + ffmpeg export. Wire up in Phase 2 as an optional `--video` flag.
