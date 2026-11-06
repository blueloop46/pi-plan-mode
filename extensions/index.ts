import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isHarmlessCommand } from "./utils.ts";

type Mode = "build" | "plan";

// Minimal approval-history breadcrumb. Persisted inside the existing plan state
// (no external files, no plan contents) so /plan status can report the last step.
type PlanAction =
	| "entered-plan"
	| "approved-here"
	| "approved-chat"
	| "approved-new-session"
	| "refining"
	| "saved-stop"
	| "handoff-rejected"
	| "handoff-started";

type PlanState = {
	mode: Mode;
	planPath?: string;
	previousThinking?: string;
	pendingHandoff?: boolean;
	approvedHash?: string;
	lastAction?: PlanAction;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const PLAN_DIR = resolve(AGENT_DIR, "plans");
export const WRITE_TOOLS = new Set(["edit", "write"]);
// Tools that are known not to write repository files; an unknown tool whose
// input contains a path key will be blocked even if it is not in WRITE_TOOLS.
export const READ_ONLY_TOOLS = new Set([
	"read", "bash", "powershell", "list_mcp_resources", "list_mcp_resource_templates",
	"read_mcp_resource", "web_search", "plan_exit", "subagent", "subagent_supervisor",
	"contact_supervisor", "bg_wait", "automode_inspect", "codemode",
	"grep", "find", "ls", "glob",
]);
function isWithin(path: string, parent: string): boolean {
	const target = resolve(path);
	return target === parent || target.startsWith(`${parent}/`);
}

// Resolve the scratch root once per extension load. Defaults to /tmp; an
// explicit PI_PLAN_SCRATCH_DIR must be absolute and must not overlap the
// canonical plan directory, otherwise scratch writes fail closed (canonical
// plan writes still work) and the reason is surfaced to the user.
function resolveScratch(): { dir?: string; warning?: string } {
	const raw = process.env.PI_PLAN_SCRATCH_DIR;
	if (!raw) return { dir: resolve("/tmp") };
	if (!isAbsolute(raw)) return { warning: `PI_PLAN_SCRATCH_DIR must be an absolute path; scratch writes are disabled (got "${raw}").` };
	const dir = resolve(raw);
	if (isWithin(PLAN_DIR, dir) || isWithin(dir, PLAN_DIR)) {
		return { warning: `PI_PLAN_SCRATCH_DIR (${dir}) overlaps the canonical plan directory (${PLAN_DIR}); scratch writes are disabled.` };
	}
	return { dir };
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// A dangling symlink still redirects writeFile to its missing target.
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Plan-mode path policy rejects dangling symbolic links.");
		return join(realPath(dirname(path)), basename(path));
	}
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

// Mirrors Pi's internal path expansion — verified against dist/utils/paths.js
// (normalizePath + resolvePath) and dist/core/tools/path-utils.js (resolveToCwd)
// in @earendil-works/pi-coding-agent v0.80.10. If Pi's expansion changes, this
// check may allow a bypass or produce a false block.
export function writePath(path: string, cwd: string): string {
	let expanded = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (expanded === "~") expanded = homedir();
	else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
	if (expanded.startsWith("file://")) expanded = fileURLToPath(expanded);
	return resolve(cwd, expanded);
}

// Reads the path parameter from a tool-call input. Pi's write and edit tools
// accept both `path` and `file_path` (verified against dist/core/tools/write.js
// and dist/core/tools/edit.js in @earendil-works/pi-coding-agent v0.80.10).
function pathFrom(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const rec = input as Record<string, unknown>;
	const value = rec.path ?? rec.file_path ?? rec.filePath;
	return typeof value === "string" ? value : undefined;
}

export default function opencodeStylePlanMode(pi: ExtensionAPI): void {
	let state: PlanState = { mode: "build" };
	let automaticHandoff: { planPath: string; approvedHash: string } | undefined;
	const { dir: scratchDir, warning: scratchWarning } = resolveScratch();

	function persist(): void {
		pi.appendEntry("opencode-plan-mode", state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("00-opencode-plan-mode", state.mode === "plan" ? ctx.ui.theme.fg("warning", "📐 plan") : undefined);
	}

	function reservePlan(name = "plan"): void {
		automaticHandoff = undefined;
		mkdirSync(PLAN_DIR, { recursive: true });
		const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
		state.planPath = join(PLAN_DIR, `${slug}-${randomUUID()}.md`);
		state.pendingHandoff = false;
		state.approvedHash = undefined;
	}

	function ensureScratch(): void {
		if (!scratchDir) return;
		try {
			mkdirSync(scratchDir, { recursive: true });
		} catch {
			// Creation failure is reported at write time via planPathAllowed's fail-closed scratch branch.
		}
	}

	function ensurePlan(): void {
		if (!state.planPath) reservePlan();
		else mkdirSync(PLAN_DIR, { recursive: true });
		ensureScratch();
	}

	function setMode(ctx: ExtensionContext, mode: Mode): void {
		automaticHandoff = undefined;
		if (mode === "plan") ensurePlan();
		if (state.mode === mode) return;
		if (mode === "plan") {
			state.previousThinking = pi.getThinkingLevel();
			state.mode = "plan";
			state.lastAction = "entered-plan";
			// router interprets virtual `high` using the active profile's high tier.
			pi.setThinkingLevel("high");
			if (ctx.hasUI) {
				ctx.ui.notify("Plan mode: investigate and write the plan; implementation is blocked.", "info");
				if (scratchWarning) ctx.ui.notify(scratchWarning, "warning");
			}
		} else {
			state.mode = "build";
			if (state.previousThinking) pi.setThinkingLevel(state.previousThinking as Parameters<typeof pi.setThinkingLevel>[0]);
			state.previousThinking = undefined;
			if (ctx.hasUI) ctx.ui.notify("Build mode: approved implementation may begin.", "info");
		}
		updateStatus(ctx);
		persist();
	}

	function planPathAllowed(path: string, cwd: string): boolean {
		const absolute = writePath(path, cwd);
		let resolvedPlan: string;
		try {
			resolvedPlan = realpathSync(PLAN_DIR);
		} catch {
			// PLAN_DIR has been removed mid-session — fail closed.
			return false;
		}
		if (scratchDir) {
			let resolvedScratch: string;
			try {
				resolvedScratch = realpathSync(scratchDir);
			} catch {
				// Scratch root is unavailable — fail closed for the scratch branch only.
				resolvedScratch = "";
			}
			if (resolvedScratch && isWithin(absolute, scratchDir) && isWithin(realPath(absolute), resolvedScratch)) return true;
		}
		return absolute === state.planPath && isWithin(absolute, PLAN_DIR) &&
			realPath(absolute) === join(resolvedPlan, basename(absolute));
	}

	function readPlan(): string {
		let resolvedPlanDir: string;
		try {
			resolvedPlanDir = realpathSync(PLAN_DIR);
		} catch {
			throw new Error(`No canonical plan is attached. Run /plan new <name> to reserve a plan under ${PLAN_DIR}.`);
		}
		if (!state.planPath || !isWithin(state.planPath, PLAN_DIR) ||
			realPath(state.planPath) !== join(resolvedPlanDir, basename(state.planPath))) {
			throw new Error(`No canonical plan is attached. Run /plan new <name> to reserve a plan under ${PLAN_DIR}.`);
		}
		try {
			if (!lstatSync(state.planPath).isFile()) throw new Error("Not a regular file");
			const content = readFileSync(state.planPath, "utf8");
			if (!content.trim()) throw new Error("Empty plan");
			return content;
		} catch {
			throw new Error(`Save a non-empty Markdown plan to ${state.planPath} with write before requesting approval. Scratch files are scratch space, not the attached plan.`);
		}
	}

	// Whole-string match only — substring matching would silently re-enable repo writes
	// on a false positive. Bare ambiguous fragments ("proceed", "yes", "ok", "go ahead")
	// are excluded; they appear naturally in planning conversation.
	function isExplicitApproval(text: string): boolean {
		const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "").replace(/\s+/g, " ");
		return /^(approved|approve|approve the plan|approve and build|go build|build it|ship it|lgtm|looks good build|execute the plan|implement the plan)$/.test(normalized);
	}

	function readinessLabel(): string {
		if (!state.planPath) return "no plan attached";
		try {
			readPlan();
			return "approval-ready (non-empty plan saved)";
		} catch {
			return "not approval-ready (empty or unsaved)";
		}
	}

	// Read-only snapshot: never changes mode, approval, plan contents, or thinking.
	function reportStatus(ctx: ExtensionContext): void {
		const lines = [
			"Plan-mode status:",
			`• Mode: ${state.mode}`,
			`• Plan: ${state.planPath ?? "none"}`,
			`• Readiness: ${readinessLabel()}`,
			`• Pending handoff: ${state.pendingHandoff ? "yes" : "no"}`,
			`• Approval hash: ${state.approvedHash ? "present" : "none"}`,
			`• Last action: ${state.lastAction ?? "none"}`,
			`• Thinking level: ${pi.getThinkingLevel()}`,
			scratchWarning ? `• Scratch: disabled — ${scratchWarning}` : `• Scratch: ${scratchDir}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	pi.registerFlag("plan", { description: "Start in OpenCode-style Plan mode", type: "boolean", default: false });

	pi.registerCommand("plan", {
		description: "Toggle Plan mode; /plan new <name> reserves a Markdown plan path; /plan status reports current state",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (/^status$/i.test(request)) {
				reportStatus(ctx);
				return;
			}
			if (request) {
				reservePlan(request.replace(/^new(?:\s+|$)/i, "").trim() || "plan");
				setMode(ctx, "plan");
				updateStatus(ctx);
				persist();
				if (ctx.hasUI) ctx.ui.notify(`Write the plan to ${state.planPath}`, "info");
				return;
			}
			setMode(ctx, state.mode === "plan" ? "build" : "plan");
		},
	});

	pi.registerCommand("build", {
		description: "Leave Plan mode and restore the previous router thinking tier",
		handler: async (_args, ctx) => setMode(ctx, "build"),
	});

	pi.registerCommand("plan-handoff", {
		description: "Start a fresh Build session with the approved plan",
		handler: async (_args, ctx) => {
			automaticHandoff = undefined;
			if (!state.pendingHandoff || !state.planPath) {
				ctx.ui.notify("No approved plan handoff is waiting.", "warning");
				return;
			}
			const content = readPlan();
			if (!state.approvedHash || hash(content) !== state.approvedHash) {
				state.pendingHandoff = false;
				state.approvedHash = undefined;
				state.lastAction = "handoff-rejected";
				persist();
				ctx.ui.notify("The plan changed after approval. Review it again with plan_exit before handing off.", "warning");
				return;
			}
			const { planPath, previousThinking } = state;
			await ctx.newSession({
				setup: async (manager) => {
					manager.appendCustomEntry("opencode-plan-mode", { mode: "build", planPath, previousThinking, lastAction: "handoff-started" });
				},
				withSession: async (next) => {
					await next.sendUserMessage(`Implement the approved plan at ${planPath}. Read it completely first, implement only the initial approved tranche, stop at its approval gates, and run its verification steps. Essential evidence is in the plan; do not rely on temporary scout reports.`);
				},
			});
		},
	});

	pi.registerTool(defineTool({
		name: "plan_exit",
		label: "Approve plan",
		description: "Offer implementation only after the canonical plan is complete, decision-ready, and presented in the conversation. Architectural study, design decisions, exploration, and evaluation belong in planning—not as deferred implementation steps. Unresolved work may remain only when it cannot reasonably be resolved during planning or the user explicitly requests deferral; label it with an implementation clarification or exploration gate. For a confined revision, present a recap of changes. Do not call merely because a draft exists.",
		exposure: "model-only",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			if (state.mode !== "plan") throw new Error("Enter Plan mode with /plan before requesting approval.");
			ensurePlan();
			const planPath = state.planPath!;
			const content = readPlan();
			automaticHandoff = undefined;
			state.pendingHandoff = false;
			state.approvedHash = undefined;
			persist();
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: `Plan saved at ${planPath}. No implementation is approved. Ask the user to review it and use /build to implement here, or review with plan_exit in a UI-enabled session for a fresh-session handoff.` }], details: { planPath, choice: "awaiting-approval" } };
			}
			const choice = await ctx.ui.select("Plan complete — choose next action", [
				"Implement here",
				"Implement in a new session",
				"Keep refining the plan",
				"Save plan and stop",
			]);
			if (state.mode !== "plan" || state.planPath !== planPath || hash(readPlan()) !== hash(content)) {
				throw new Error("The plan or mode changed during review. Review the saved plan again before implementation.");
			}
			if (choice === "Implement here") {
				state.lastAction = "approved-here";
				setMode(ctx, "build");
				return { content: [{ type: "text", text: `Approved. Begin implementing the initial approved tranche of ${planPath} now. Read the plan, execute the first step immediately, and do not stop to summarise or ask for confirmation before starting. Stop only at the plan's explicit approval gates.` }], details: { planPath, choice: "here" } };
			}
			if (choice === "Implement in a new session") {
				state.pendingHandoff = true;
				state.approvedHash = hash(content);
				state.lastAction = "approved-new-session";
				automaticHandoff = { planPath, approvedHash: state.approvedHash };
				persist();
				return { content: [{ type: "text", text: `Approved for a fresh Build session. Starting implementation of the approved plan at ${planPath}; do not implement in this session.` }], details: { planPath, choice: "new-session" }, terminate: true };
			}
			if (choice === "Keep refining the plan") {
				state.lastAction = "refining";
				persist();
				return { content: [{ type: "text", text: "Staying in Plan mode to refine the saved plan. No implementation is approved." }], details: { planPath, choice: "refine" } };
			}
			if (choice === "Save plan and stop") {
				state.lastAction = "saved-stop";
				persist();
			}
			return { content: [{ type: "text", text: "Plan saved; staying in Plan mode. Stop here without implementation or another approval prompt unless the user asks." }], details: { planPath, choice: choice ? "stop" : "cancel" } };
		},
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (state.mode !== "plan") return;
		if (WRITE_TOOLS.has(event.toolName)) {
			const path = pathFrom(event.input);
			if (!path || !planPathAllowed(path, ctx.cwd)) {
				const scratchHint = scratchDir ? `or scratch files inside ${scratchDir}` : "(scratch writes are disabled)";
				return { block: true, reason: `Plan-mode path policy: write only to ${state.planPath ?? PLAN_DIR} ${scratchHint}. Save the final plan at the attached path. Repository changes require implementation approval.` };
			}
			if (writePath(path, ctx.cwd) === state.planPath) {
				automaticHandoff = undefined;
				state.pendingHandoff = false;
				state.approvedHash = undefined;
				persist();
			}
		}
		if (["bash", "powershell"].includes(event.toolName)) {
			if (!event.input || typeof event.input !== "object") {
				return { block: true, reason: "Plan-mode shell policy: tool input is not an object; cannot validate command. Repository changes require Build mode." };
			}
			const command = (event.input as Record<string, unknown>).command;
			if (event.toolName === "powershell" || !isHarmlessCommand(command)) {
				return { block: true, reason: "Plan-mode shell policy: only supported read-only bash commands are allowed, individually or separated by ;, &&, or a newline. Use read/grep/find/ls for inspection. DOCX: unzip -p 'file.docx' word/document.xml; PDF: pdftotext 'file.pdf' -. Arbitrary scripts, PowerShell, pipelines, redirections, mutating options, and test/build runners require Build mode. Do not disable the policy to investigate." };
			}
		}
		// Block any unknown tool (not in WRITE_TOOLS, not in READ_ONLY_TOOLS) whose input
		// contains a path key — catches future write-capable tools before they're classified.
		if (!WRITE_TOOLS.has(event.toolName) && !READ_ONLY_TOOLS.has(event.toolName)) {
			const unknownPath = pathFrom(event.input);
			if (unknownPath !== undefined) {
				return { block: true, reason: `Plan-mode path policy: unknown tool "${event.toolName}" has a path parameter. Only read-only tools may use path parameters in Plan mode. Repository changes require implementation approval.` };
			}
		}
	});

	pi.on("agent_settled", async (event) => {
		const handoff = automaticHandoff;
		automaticHandoff = undefined;
		if (event.aborted || !handoff || state.mode !== "plan" || !state.pendingHandoff ||
			state.planPath !== handoff.planPath || state.approvedHash !== handoff.approvedHash) return;
		pi.sendUserMessage("/plan-handoff", { expandPromptTemplates: true });
	});

	pi.on("context", async (event) => {
		if (state.mode === "plan") return;
		return { messages: event.messages.filter((message) => (message as { customType?: string }).customType !== "opencode-plan-mode-context") };
	});

	// Chat-based approval: fires before before_agent_start, so when we flip to Build here
	// the plan-mode context injection and tool_call write-block are already bypassed.
	// interactive-source only — "extension" source carries internal dispatches like
	// /plan-handoff (sendUserMessage in agent_settled) and must not be matched.
	pi.on("input", async (event, ctx) => {
		if (state.mode !== "plan" || event.source !== "interactive") return { action: "continue" };
		if (!isExplicitApproval(event.text)) return { action: "continue" };
		// Require a saved, non-empty plan — guards against an incidental match before the plan exists.
		try {
			readPlan();
		} catch {
			return { action: "continue" };
		}
		const planPath = state.planPath!;
		state.lastAction = "approved-chat";
		setMode(ctx, "build");
		// Transform the input to the implementation instruction so the agent has a concrete task.
		// If plan_exit selector is open concurrently, setMode is idempotent (early-returns when
		// mode is already build) so there is no double-transition or state corruption.
		return {
			action: "transform",
			text: `Approved — read the saved plan at ${planPath} and begin implementing its initial approved tranche immediately. Execute the first step now; do not stop to summarise or ask for confirmation before starting. Stop only at the plan's explicit approval gates.`,
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// Pi runs newSession.setup after session_start; pick up its Build handoff state.
		restore(ctx);
		if (state.mode !== "plan") return;
		ensurePlan();
		const scratchNote = scratchDir
			? `You may also write scratch files in ${scratchDir}, but those are not an attached plan and cannot be approved.`
			: `Scratch writes are disabled (${scratchWarning}), so write only the canonical plan above.`;
		return {
			message: {
				customType: "opencode-plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are planning, not coding. Write the final Markdown plan to this exact canonical path: ${state.planPath}. Its parent directory already exists. ${scratchNote}

Explore with read-only tools and supported read-only bash commands. Safe commands may be separated by ;, &&, or newlines. Do not use arbitrary scripts, pipelines, PowerShell, or test/build runners. To inspect documents without conversion files: unzip -p 'file.docx' word/document.xml; pdftotext 'file.pdf' -.

Use subagents only when authorized; they must investigate read-only. Give each child one configured output destination, do not request a second report path in task prose, and explicitly permit its managed report artifact. Read the returned output reference after completion and resume planning without polling. Include essential findings and source references in the canonical plan so a new session does not depend on temporary reports.

PHASE 1 — Investigate and shape the solution. Treat planning as a collaborative design process, not transcription of the request or a race to an approval menu. Investigate read-only to ground yourself in the actual code, patterns, and constraints. You may write and revise the canonical plan early as a working draft; a saved draft is not evidence that planning is complete and is not a reason to request approval.
- Surface and challenge assumptions. Do not blindly accept the user's proposed mechanism; if it is wrong, unsafe, over-engineered, or inefficient, say so plainly and recommend a smaller or better alternative. Reuse existing patterns and dependencies.
- Proactively ask high-value questions whose answers affect requirements, architecture, scope, behavior, compatibility, rollout, or verification. Scale the depth to the task: few or none for genuinely trivial and fully specified work; multiple focused rounds for ambiguous, risky, cross-cutting, or architectural work. Prefer 1–3 concrete questions at a time, ranked by impact, and use ask_user_question when available. Do not wait for the user to drive the analysis or repeatedly reject premature approval.
- Explore the solution space before settling. For non-trivial choices, present 2–3 meaningfully different approaches with explicit trade-offs in complexity, risk, performance, maintainability, effort, blast radius, and reversibility. Recommend one and explain why. Investigate further when evidence is missing rather than converting the unknown into an implementation task.
- Iterate with the user until the important questions and objections are resolved and the recommended direction is well defined. Do not interpret a request to adjust one detail as acceptance of every other assumption. If user input is needed, ask and wait; do not request implementation approval in the same turn.

PHASE 2 — Complete and review the plan. Keep the canonical Markdown plan current, using these sections: Goal (what we are building and why); Context and constraints (relevant existing code, patterns, dependencies, hard constraints found during investigation); Assumptions and open questions; Options considered (candidate approaches, trade-offs, and rejected alternatives); Recommended approach (chosen design, architecture, and data/control flow, with a small diagram when helpful); Affected files and changes (file-by-file); Implementation Steps (small, independently verifiable increments in dependency order); Edge cases and test strategy; Risks and rollback; Verification (Agent and User); and Handover. State the initial executable tranche and later approval gates explicitly. Prefer concrete detail over generic phrasing: name real files, functions, and commands rather than placeholders.

READINESS GATE — perform this review before requesting approval. Approval is appropriate only when the plan is well thought through and defined from every relevant angle:
- requirements, scope, boundaries, assumptions, and acceptance criteria are explicit;
- codebase investigation is sufficient to name the affected components and explain the current and proposed flow;
- consequential architecture and design decisions were evaluated during planning, alternatives and trade-offs are recorded, and the recommendation is justified;
- implementation steps contain implementation, migration, testing, rollout, and verification work—not architectural study, option evaluation, requirements discovery, or design decisions that could be completed now;
- edge cases, failure modes, compatibility, security/privacy, performance, observability, rollout/rollback, and testing were considered where relevant;
- open questions are either resolved or clearly non-blocking.

Do not use "investigate", "explore", "evaluate", "decide", "design", or "clarify" as implementation steps merely to end planning sooner. Normally those activities are part of planning and must be completed before approval. Exception: an unknown cannot reasonably be resolved without implementation-time access/evidence, or the user explicitly asks to defer it. In that case, state why it cannot be resolved now, document the bounded clarification or exploration step, its owner/evidence, safe default, decision criteria, possible outcomes, and an explicit stop/go approval gate before dependent implementation. If the readiness review reveals a material gap, continue investigating or ask the user focused questions; do not show the approval menu.

PHASE 3 — Present only when ready. Once the readiness gate passes, present the user in the normal assistant conversation a detailed but concise summary: goal, key decisions and trade-offs, affected scope, implementation sequence, verification, risks, any explicitly deferred unknowns, initial tranche, and approval gates. Do not paste the entire plan or ask the user to open its internal path. If only a confined change was made to a plan you presented a few turns ago, present only the changes and their effects. Then call plan_exit without asking for a separate preliminary approval. Before calling it, tell the user: "The plan is ready. I'll show you the approval menu now. You can also reply 'approve' to implement here immediately, or type /build to leave Plan mode manually." Do not mention plan_exit as something the user needs to call. If the selector is unavailable, explain the chat and /build alternatives. Never ask the user to discover an internal plan path.`, 
				display: false,
			},
		};
	});

	function restore(ctx: ExtensionContext): void {
		automaticHandoff = undefined;
		const entry = ctx.sessionManager.getBranch().filter((item) => item.type === "custom" && item.customType === "opencode-plan-mode").pop();
		state = entry?.type === "custom" ? { ...(entry.data as PlanState) } : { mode: "build" };
		if (!entry && pi.getFlag("plan") === true) setMode(ctx, "plan");
		if (state.mode === "plan") {
			const missingPath = !state.planPath;
			ensurePlan();
			pi.setThinkingLevel("high");
			if (missingPath) persist();
		} else if (state.previousThinking) {
			pi.setThinkingLevel(state.previousThinking as Parameters<typeof pi.setThinkingLevel>[0]);
			state.previousThinking = undefined;
			persist();
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
}
