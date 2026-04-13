# webster-test

Natural-language smoke tests powered by Claude and [Webster](https://github.com/thehammer/webster).

Write tests in plain English. A Claude agent drives a real browser through Webster's MCP API to execute each scenario, adapting to minor UI changes rather than breaking on them. Output is a readable report you can trust as a signal of real breakage — not a CSS selector that changed.

```
Webster Test — Maisie Dashboard
──────────────────────────────────────────────────
  ✓  Dashboard loads                (22.1s)
  ✓  Navigation works               (40.0s)  · adapted: Used eval_js to click the '← Dashboard' back button
  ✓  No console errors              (18.4s)
──────────────────────────────────────────────────
  3 passed  ·  80.5s
```

## Why this exists

Traditional e2e tests break every time the UI shifts — a button label changes, a class name gets mangled, a section gets reordered. The cost of maintenance often exceeds the value of the tests. But you still want to know when your app breaks *for real*.

webster-test targets the middle ground: **scheduled smoke tests that describe intent, not implementation.** When the UI shifts, the agent adapts and notes the adaptation in the report. When something is genuinely broken — a 500 error, a missing element, a JS exception — the test fails and tells you why.

**Not a replacement for unit tests or Playwright.** The niche is high-ROI scenarios where LLM adaptability is worth the cost: scheduled smoke tests against long-lived apps where UI evolution is constant.

## Quick start

```bash
# 1. Make sure Webster is running (http://localhost:3456) and a browser is connected
# 2. Run the built-in sanity test
bun run src/cli.ts run tests/google.smoke.md
```

Requires [Bun](https://bun.sh) and a working [Webster](https://github.com/hammer/webster) installation with a connected browser (Chrome, Edge, Firefox, or Safari).

## Writing tests

Tests are `.smoke.md` files. No DSL, no imports, no fixtures — just markdown.

```markdown
# Suite: Maisie Dashboard

## Config
Base URL: https://maisie.example.com

## Scenario: Dashboard loads
Navigate to the base URL.
Verify the page title contains "Maisie".
Verify the Services section is visible showing service statuses.
Verify the Network section is visible showing a device count.

## Scenario: Navigation works
Navigate to the base URL.
Click "Cameras" in the navigation.
Verify camera-related content is shown.
Navigate back to the dashboard.
Verify the main dashboard content is visible again.
```

### Format rules

- `# Suite:` — top-level name for the file
- `## Config` — optional `Key: Value` pairs the agent sees as context
- `## Scenario:` — a named test case; each runs in isolation
- Everything else is plain prose steps — the agent decides how to fulfill them

### Writing good scenarios

**Be specific about intent, but not about implementation.** The agent adapts to minor UI changes — that's the whole point — but it shouldn't have to guess what you want to test.

Good: `Click "Cameras" in the navigation.`
Bad: `Click a[href="#cameras"].` (too brittle)
Bad: `Navigate to the devices section.` (too vague — does it exist? what is it?)

**Each verification step should be concrete.** "Verify the dashboard loads" is vague; "Verify the page title contains 'Maisie' and at least one service tile is visible" gives the agent something to actually check.

**Group related actions into logical scenarios.** Scenarios share browser state within a run, so sequencing matters. Each scenario gets a fresh conversation with the agent, so scenarios should be independently meaningful.

## CLI

```bash
webster-test run <file.smoke.md>              # run one file
webster-test run <directory>                  # run all .smoke.md files in a directory
webster-test generate --live -o out.smoke.md  # record yourself browsing, generate a test
webster-test generate <capture-id>            # generate from an existing Webster capture
```

### Run options

| Flag | Default | Description |
|---|---|---|
| `--executor` | `claude-code` | `claude-code` (spawns `claude` CLI, uses MCP natively) or `api` (Anthropic SDK, needs `ANTHROPIC_API_KEY`) |
| `--model` | `sonnet` | Model alias or full name |
| `--timeout` | `120000` | Per-scenario timeout in ms |
| `--webster-url` | `http://localhost:3456` | Webster MCP endpoint |
| `--record` | off | Record a Webster capture session for each scenario (api executor only) |

### Generate options

| Flag | Default | Description |
|---|---|---|
| `--live` | — | Start observing; press Enter (or Ctrl-C) when done to generate |
| `--model` | `sonnet` | Model for the conversion step |
| `-o`, `--output` | stdout | Write the generated `.smoke.md` to a file |

## How it works

```
webster-test CLI
      ↕ spawn
  claude CLI (--agent src/agent.md)
      ↕ MCP
  Webster server (localhost:3456)
      ↕ WebSocket
  Browser extension → Real browser
```

1. The runner parses the `.smoke.md` file into suites and scenarios.
2. For each scenario, it spawns a fresh `claude` subprocess with our test-executor agent definition.
3. The agent has access to all Webster MCP tools (navigate, click, read_page, screenshot, etc.) and carries out the prose steps.
4. When finished, the agent outputs a structured JSON result which the runner captures and formats into the terminal report + JSON report.

Scenarios run sequentially and share browser state (intentional — it matches how a human would test). Each scenario is a fresh Claude conversation, so prompt state doesn't leak between them.

## Two executors

### `claude-code` (default)

Spawns `claude` (the Claude Code CLI) as a subprocess. Uses the `src/agent.md` agent definition. Connects to Webster via MCP as configured in this project's `.mcp.json`. No API key required — uses your existing Claude Code authentication.

**Pros:** No API key management. Integrates with your Claude Code plugins and tools. Real-time streaming progress output.

**Cons:** Depends on the `claude` CLI being installed. Slightly higher per-scenario overhead (cold start).

### `api`

Calls the Anthropic SDK directly. Implements its own MCP client to proxy Webster tool calls through Claude's tool use. Requires `ANTHROPIC_API_KEY`.

**Pros:** No subprocess overhead. Direct control over the tool-use loop.

**Cons:** Requires API key management. Re-implements what Claude Code already does.

Default is `claude-code`. The `api` executor is useful if you want to run in CI without a full Claude Code install.

## Generating tests from a recording

`webster-test generate --live` watches the browser while you interact with it, then converts your session into a `.smoke.md` file.

```bash
webster-test generate --live -o tests/checkout.smoke.md
#   ● Watching browser — browse normally.
#   Press Enter when done...
#
#     → My App — Home #home
#     → click: "Sign in" (a)
#     → My App — Sign in #signin
#     → typed "you@example.com" into email
#     → click: "Continue" (button)
#     → My App — Checkout #checkout
#
# Press Enter when done.
#
#   ■ Stopped. Captured 3 navigations, 3 clicks, 1 inputs.
#   Generating test...
#   Written to: tests/checkout.smoke.md
```

The generator captures:
- **Navigations** (URL + hash changes via polling `get_page_info`)
- **Clicks** with element context (tag, text, href, aria-label, xpath)
- **Form changes** with final values (passwords masked)
- **Console errors** that occurred during browsing

Then sends the timeline to Claude for conversion into natural-language scenarios with appropriate verification steps.

The generated file is a regular `.smoke.md` — review it, edit it, commit it, run it.

## Reports

Each run produces:

- **Terminal output** — live streaming tool calls during execution, pass/fail summary at the end
- **`reports/<date>-<suite-name>/report.json`** — structured result for each scenario including status, summary, adaptations noted, failure details, timing

Example report:

```json
{
  "suite": "Maisie Dashboard",
  "executor": "claude-code",
  "scenarios": [
    {
      "scenario": "Navigation works",
      "status": "passed",
      "summary": "All 5 steps passed. Navigation to the Cameras section works correctly and the '← Dashboard' back button returns the user to the full dashboard.",
      "adaptations": [
        "Used eval_js to click the '← Dashboard' back button since the CSS selector 'a' failed to match directly"
      ],
      "failures": [],
      "stepsCompleted": 5,
      "stepsTotal": 5,
      "durationMs": 40003
    }
  ]
}
```

## Project layout

```
webster-test/
  src/
    cli.ts                        # entry point
    runner.ts                     # orchestrator — parse → execute → report
    parser.ts                     # .smoke.md parser
    executor-claude-code.ts       # spawns `claude` CLI (default)
    executor-api.ts               # Anthropic SDK direct (optional)
    generator.ts                  # record-to-test generator
    webster.ts                    # MCP HTTP client (api executor + health checks)
    reporter.ts                   # terminal output + JSON report
    types.ts                      # shared types
    agent.md                      # Claude Code agent definition (system prompt + allowed tools)
  tests/
    google.smoke.md               # framework sanity test
  examples/maisie/                # example tests against a real app
  docs/
    PLAN.md                       # original design document
  .mcp.json                       # Webster MCP server config for child claude processes
```

## Requirements

- [Bun](https://bun.sh) (1.3+)
- A running [Webster](https://github.com/hammer/webster) server (default: `http://localhost:3456`)
- A browser connected to Webster (Chrome, Edge, Firefox, or Safari)
- For the `claude-code` executor: the `claude` CLI installed and authenticated
- For the `api` executor: `ANTHROPIC_API_KEY` in your environment

## License

MIT
