# Plan mode

Local Pi extension for investigation, a saved Markdown plan, and explicit implementation approval.

## Installation and reload

This is a local extension, not an npm package. Place it at `$PI_CODING_AGENT_DIR/extensions/plan-mode` (defaulting to `~/.pi/agent/extensions/plan-mode`) by copying the directory or symlinking it from your checkout:

```sh
ln -s "$PWD/extensions/plan-mode" ~/.pi/agent/extensions/plan-mode
```

Pi auto-loads extensions found under that directory; no `settings.json` `packages` entry is needed. After editing any file in the extension, run `/reload` in Pi to activate the changes. Existing saved plans are preserved across reloads.

## Commands

- `/plan` — toggle Plan mode (or start Pi with `--plan`).
- `/plan new <name>` — reserve a new uniquely named canonical plan path without overwriting an existing one.
- `/plan status` — read-only snapshot of the current state (see below). It never changes mode, approval, plan contents, or thinking level.
- **`/build` — the primary exit command: leaves Plan mode explicitly and restores the previous router thinking tier. Use this when you want to exit Plan mode without waiting for approval, or after `plan_exit` is blocked or the session is stuck.**
- **Explicit chat approval** — after the saved plan has been presented, reply with one of the exact trigger phrases: `approved`, `approve`, `approve the plan`, `approve and build`, `build it`, `go build`, `ship it`, `lgtm`, `execute the plan`, `implement the plan`. The extension validates that a non-empty canonical plan exists, then leaves Plan mode and rewrites the message to the implementation instruction in the current session. This is equivalent to choosing **Implement here** in the approval menu; it never selects **Implement in a new session**. Only interactive input is matched; ambiguous fragments and longer messages do not trigger this behavior.
- `/plan-handoff` — after an approved **Implement in a new session**, start the fresh Build session. The extra command is required because Pi session replacement is command-only.
- `plan_exit` — model-only tool that validates the saved plan and presents the approval selector.

## Workflow

1. Enter `/plan` (or start Pi with `--plan`). The extension reserves a unique canonical plan path under `$PI_CODING_AGENT_DIR/plans`, defaulting to `~/.pi/agent/plans`, and creates its parent directory. The exact path is included in the agent's instructions.
2. **Investigation and collaborative design.** The agent investigates read-only, surfaces assumptions, and proactively asks focused questions that affect requirements, architecture, scope, compatibility, rollout, or verification. For non-trivial choices it compares meaningful alternatives and recommends one. The canonical file may be written early as a working draft, but a saved draft is not approval-ready and does not end planning.
3. **Complete the plan and pass the readiness gate.** The plan covers: Goal; Context and constraints; Assumptions and open questions; Options considered; Recommended architecture and data/control flow; Affected files and changes; Implementation Steps; Edge cases and test strategy; Risks and rollback; Verification; and Handover. Architectural study, option evaluation, requirements clarification, and consequential design decisions are normally completed during planning—not deferred as implementation steps. A genuinely unresolvable unknown, or one the user explicitly asks to defer, must be bounded with its reason, evidence/owner, safe default, decision criteria, possible outcomes, and a stop/go gate.
4. **Request approval only when complete.** Before presenting the plan, the agent checks that scope and acceptance criteria are explicit; codebase investigation supports the proposed flow and affected files; material alternatives and trade-offs are resolved; relevant edge cases, security/privacy, performance, observability, compatibility, rollout/rollback, tests, and verification are addressed; and remaining questions are non-blocking. If a material gap remains, it continues investigating or asks focused questions instead of opening the approval menu. Once ready, it presents a detailed but concise summary and calls `plan_exit`; this opens an interactive approval menu that the user selects with the arrow keys and Enter:
   - **Implement here:** switch to Build mode and implement the initial approved tranche in the current session.
   - **Implement in a new session:** approve the current plan version and start a fresh Build session through `/plan-handoff`.
   - **Keep refining the plan:** remain in Plan mode without approving implementation.
   - **Save plan and stop:** keep the saved plan without starting implementation.

   Before calling `plan_exit`, tell the user: **"The plan is ready. I'll show an approval menu where you can choose Implement here or Implement in a new session. Alternatively, reply `approve` to implement here immediately, or type `/build` to leave Plan mode manually."**

   The chat shortcut `approve` is equivalent to **Implement here** only. It does not open the menu or select the fresh-session option. `/build` exits Plan mode manually without formal approval; it is a fallback, not a replacement for the approval menu.

The bottom status line shows `📐 plan` while Plan mode is active and clears when Build mode is restored. Cancelling the action selector also leaves implementation unapproved. A missing, empty, symlinked, or changed plan cannot be approved. Editing an approved plan invalidates its pending handoff. A cancelled session switch keeps the pending handoff available.

Session resume and tree navigation restore the active branch's plan state including plan path, thinking level, pending handoff, and `lastAction` breadcrumb. In non-UI mode, `plan_exit` reports the saved path but does not grant approval; the user can use `/build` explicitly or return to a UI-enabled session for review/handoff. Explicit chat approval is intentionally limited to exact short approval phrases and only works when a valid saved canonical plan exists.

## /plan status

`/plan status` is a read-only snapshot. It never enters Plan mode, allocates a plan path, changes the approval state, modifies plan contents, or adjusts the thinking level. It reports via `ctx.ui.notify`, which works in both TUI and RPC modes. The notification shows:

- Current mode (build / plan)
- Canonical plan path (or `none`)
- Readiness: whether the plan is non-empty and approval-ready, or not
- Pending handoff state (yes/no)
- Approval hash presence (present / none)
- Last action (breadcrumb — see `lastAction` in the state section below)
- Current thinking level
- Scratch root (configured path, or disabled with reason)

## Scratch space

During Plan mode the agent may write scratch files to the scratch root (default `/tmp`). These are not an attached plan and cannot be approved. The scratch root is resolved once at extension load:

- If `PI_PLAN_SCRATCH_DIR` is **not set**, the scratch root is `/tmp` (the previous default).
- If `PI_PLAN_SCRATCH_DIR` **is set**, it must be an absolute path. A relative value disables scratch writes and shows a clear warning in `/plan status` and on entering Plan mode.
- If the configured scratch root overlaps the canonical plan directory (`$PI_CODING_AGENT_DIR/plans`), scratch writes are also disabled.
- The same realpath/symlink containment checks that apply to `/tmp` apply to the configured scratch root.
- A disabled scratch root does **not** affect canonical plan writes; those continue to work.

```sh
export PI_PLAN_SCRATCH_DIR=/Users/me/scratch/pi
```

## Approval history (lastAction)

The existing `PlanState` entry carries a small `lastAction` breadcrumb (one of `entered-plan`, `approved-here`, `approved-new-session`, `refining`, `saved-stop`, `handoff-rejected`, `handoff-started`). It is set by commands and `plan_exit` and persisted with the rest of state. No plan contents are stored and no external files are added. It is readable via `/plan status` and survives session resume.

## AGENTS.md interaction

This extension does not read or write `AGENTS.md`. If `AGENTS.md` contains project instructions relevant to a plan, the agent should include the key constraints in the canonical plan file so they are available in a fresh Build session that may not share the same working directory.

## Read-only exploration

Use built-in file tools where possible. Supported bash commands can be separated by `;`, `&&`, or a newline, provided every command passes the policy. Quotes around paths and search patterns are supported; shell expansion, pipelines, redirection, arbitrary interpreters, PowerShell, and test/build runners are not. Unquoted globs are rejected to prevent filename-to-option injection.

Document inspection without creating conversion files:

```sh
unzip -p 'example.docx' word/document.xml
pdftotext 'example.pdf' -
```

These commands require locally installed `unzip`/`pdftotext`; nothing is installed automatically. XML extraction does not verify Word layout or PDF diagrams. Run tests/builds only after implementation approval: even apparently harmless scripts can modify files.

For delegated investigation, configure one report destination rather than a second destination in task prose, allow the managed report artifact explicitly, and read the returned output reference. Put essential findings and source references in the canonical plan so a fresh session does not depend on temporary reports.

The shell/path checks are conservative guardrails, **not an OS sandbox**. They cover built-in write/edit and bash/PowerShell calls, not every third-party tool or child process; ambient tool configuration and concurrent filesystem changes are not isolated. Subagents still require a read-only task contract.

## Safety boundaries

- **Path policy:** in Plan mode, `write`/`edit` are restricted to the canonical plan path and the configured scratch root. All other paths are blocked. The realpath/symlink containment check prevents writes through symlinks that target outside allowed roots. Dangling symlinks are rejected.
- **Shell policy:** only the supported read-only bash subset is allowed in Plan mode; PowerShell, pipelines, redirections, test/build runners, and arbitrary interpreters are blocked regardless of how they are spelled.
- **Unknown tools:** an unknown tool (not in `WRITE_TOOLS` or `READ_ONLY_TOOLS`) with a `path` parameter is blocked in Plan mode.
- These are guardrails, not an OS sandbox; they cover Pi's built-in tools, not every MCP or third-party tool.

## Regression checks

Requires the installed Pi runtime and Node with TypeScript stripping. From the extension directory:

```sh
npm test
```

Or from the repo root:

```sh
node --experimental-strip-types --test extensions/plan-mode/utils.test.ts extensions/plan-mode/index.test.ts
```

Or against the installed copy:

```sh
node --experimental-strip-types --test ~/.pi/agent/extensions/plan-mode/utils.test.ts ~/.pi/agent/extensions/plan-mode/index.test.ts
```

The lifecycle tests load the extension through Pi's real loader, use a disposable custom profile under `/tmp`, and mock UI/session replacement. They cover path allocation and expansion, save validation, that approval does not open a custom preview, the four action choices, approval drift, cancellation, handoff (including Pi's late setup callback), resume, `--plan`, `/plan status`, configurable scratch root (`PI_PLAN_SCRATCH_DIR` absolute/relative/overlap), and `lastAction` breadcrumbs. Shell tests classify command strings; they never execute destructive examples.

## Manual smoke tests

The lifecycle tests fake session-entry ordering, the thinking level, session replacement, and `agent_settled` timing (see the fidelity notes in `index.test.ts`). After a Pi upgrade, run these four ordering-sensitive paths by hand in a real Pi session to confirm the fakes still match Pi's behaviour:

1. **New-session handoff ordering:** enter `/plan`, save a plan, call `plan_exit`, choose **Implement in a new session**. Expected: the status indicator shows `plan`, the thinking indicator shows high, a fresh session starts automatically (via the dispatched `/plan-handoff`) in mode `build`, and the first implementation prompt references the saved plan path.
2. **Branch/tree resume:** in a plan-mode session, navigate to a previous branch in the session tree. Expected: the status indicator updates to match the restored branch, the restored branch's plan path is reattached, the thinking level is restored (high while in plan mode), and `before_agent_start` re-injects the `[PLAN MODE ACTIVE]` context message.
3. **`--plan` flag on startup:** start Pi with `--plan`. Expected: mode is `plan` on the first turn, the thinking indicator shows high, and the status indicator shows `plan`.
4. **Cancel during handoff selector:** call `plan_exit`, choose **Implement in a new session**, then cancel the new session (for example Esc on the session-start confirmation). Expected: `pendingHandoff` stays true, no implementation session starts, and `/plan-handoff` can be re-run manually to retry the switch.

Each outcome is concrete enough to verify directly against the on-screen status indicator, thinking indicator, and the session that is (or is not) started.
