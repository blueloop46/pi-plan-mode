import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Load through Pi itself so host imports, schemas, and registration are checked too.
const installedAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const loader = join(installedAgent, "npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const { loadExtensions } = await import(pathToFileURL(loader).href);
const { loadThemeFromPath, setThemeInstance } = await import(pathToFileURL(join(dirname(loader), "../../modes/interactive/theme/theme.js")).href);
const localThemePath = join(dirname(loader), "../../modes/interactive/theme/dark.json");
setThemeInstance(loadThemeFromPath(localThemePath));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const sandbox = mkdtempSync("/tmp/pi-plan-test-");
const profile = join(sandbox, "custom-profile");
const source = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
process.env.PI_CODING_AGENT_DIR = profile;

// Import index.ts through jiti with the same package aliases Pi's loader uses so
// its named exports (WRITE_TOOLS, READ_ONLY_TOOLS, writePath) can be cross-checked
// against Pi's real built-in tool registry and path resolver. The Pi loader itself
// returns only the default factory, so it cannot surface these named exports.
const piModules = join(installedAgent, "npm/node_modules");
const piAiCompat = join(piModules, "@earendil-works/pi-ai/dist/compat.js");
const { createJiti } = await import(pathToFileURL(join(piModules, "jiti/lib/jiti-static.mjs")).href);
const indexJiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": join(piModules, "@earendil-works/pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-agent-core": join(piModules, "@earendil-works/pi-agent-core/dist/index.js"),
		"@earendil-works/pi-tui": join(piModules, "@earendil-works/pi-tui/dist/index.js"),
		"@earendil-works/pi-ai": piAiCompat,
		"@earendil-works/pi-ai/compat": piAiCompat,
	},
});
const { WRITE_TOOLS, READ_ONLY_TOOLS, writePath } = await indexJiti.import(source);

async function harness(seed: any[] = [], flag = false) {
	const loaded = await loadExtensions([source], sandbox);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const { runtime } = loaded;
	const dispatched: { content: string; options: any }[] = [];
	let dispatchIndex = 0;
	let branch = structuredClone(seed);
	let thinking = "off";
	let choice: string | undefined = "Keep refining the plan";
	let onSelect = () => {};
	let cancelSession = false;
	let newSessionEntries: any[] = [];
	const messages: any[] = [];
	const prompts: string[] = [];
	const notices: string[] = [];
	const statuses = new Map<string, string>();
	// Harness fidelity notes:
	// - Uses real Pi loader: loadExtensions above is Pi's real extension loader, so
	//   tool schemas, tool registration, and handler/command wiring are all real.
	// - Faked below: session entry ordering (appendEntry writes straight into the
	//   local `branch`), the thinking level (held in the `thinking` variable),
	//   newSession (commandCtx stubs it; there is no real Pi session replacement),
	//   ctx.ui select/notify/setStatus (synchronous stubs), and agent_settled
	//   dispatch timing (settle() drains synchronously with no real event-loop delay).
	// - Ordering assumption: Pi calls session_start before newSession.setup. The
	//   handoff path asserts this explicitly (the `fresh` block runs session_start
	//   then replays the new-session entries); other event orderings are not tested.
	runtime.appendEntry = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data: structuredClone(data) });
	runtime.getThinkingLevel = () => thinking;
	runtime.setThinkingLevel = (value: string) => { thinking = value; };
	runtime.sendMessage = (message: unknown) => messages.push(message);
	runtime.sendUserMessage = (content: string, options: any) => dispatched.push({ content, options });
	runtime.flagValues.set("plan", flag);
	const ctx: any = {
		cwd: sandbox,
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value?: string) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
			notify: (text: string) => notices.push(text),
			custom: async () => { throw new Error("Plan approval must not open a custom preview"); },
			select: async (title: string, options: string[]) => {
				assert.equal(title, "Plan complete — choose next action");
				assert.equal(options.length, 4);
				onSelect();
				return choice;
			},
		},
	};
	const commandCtx = {
		...ctx,
		newSession: async (options: any) => {
			if (cancelSession) return { cancelled: true };
			newSessionEntries = [];
			await options.setup({
				appendCustomEntry: (customType: string, data: unknown) => newSessionEntries.push({ type: "custom", customType, data }),
			});
			// Any old pi API usage after replacement must fail, as it does in Pi.
			runtime.invalidate();
			await options.withSession({ sendUserMessage: async (text: string) => prompts.push(text) });
			return { cancelled: false };
		},
	};
	const event = async (name: string, input: any = {}) => {
		let result: any;
		for (const handler of extension.handlers.get(name) || []) result = await handler(input, ctx);
		return result;
	};
	const command = (name: string, args = "") => extension.commands.get(name).handler(args, commandCtx);
	const settle = async (aborted = false) => {
		await event("agent_settled", { aborted });
		// Like Pi, dispatch expanded commands only after settled handlers return.
		while (dispatchIndex < dispatched.length) {
			const request = dispatched[dispatchIndex++];
			assert.equal(request.options.expandPromptTemplates, true);
			assert.equal(request.content, "/plan-handoff");
			await command("plan-handoff");
		}
	};
	const exit = () => extension.tools.get("plan_exit").definition.execute("review", {}, undefined, undefined, ctx);
	const state = () => branch.filter((entry: any) => entry.customType === "opencode-plan-mode").at(-1)?.data;
	return {
		ctx, event, command, exit, state, messages, prompts, notices, settle,
		statuses,
		dispatched: () => dispatched,
		thinking: () => thinking,
		entries: () => branch,
		newEntries: () => newSessionEntries,
		choose: (value?: string) => { choice = value; },
		onSelect: (callback: () => void) => { onSelect = callback; },
		cancelSession: (value: boolean) => { cancelSession = value; },
		setBranch: (value: any[]) => { branch = value; },
	};
}

try {
	const h = await harness();
	await h.event("session_start");
	await h.command("plan");
	const planPath = h.state().planPath;
	assert.equal(dirname(planPath), join(profile, "plans"));
	assert.equal(existsSync(dirname(planPath)), true);
	assert.equal(existsSync(planPath), false);
	assert.equal(h.thinking(), "high");
	assert.equal(h.statuses.get("00-opencode-plan-mode"), "📐 plan");
	const context = await h.event("before_agent_start");
	assert.ok(context.message.content.includes(planPath));
	assert.ok(context.message.content.includes("one configured output destination"));
	assert.ok(context.message.content.includes("normal assistant conversation a detailed but concise summary"));
	assert.ok(context.message.content.includes("only a confined change was made to a plan you presented a few turns ago"));
	assert.ok(context.message.content.indexOf("present the user") < context.message.content.indexOf("Then call plan_exit"));
	assert.ok(!context.message.content.includes("~/.pi/agent/plans"));
	await assert.rejects(h.exit(), /Save a non-empty Markdown plan/);
	writeFileSync(planPath, " \n");
	await assert.rejects(h.exit(), /Save a non-empty Markdown plan/);

	const content = "# Pilot plan\n\nImplement the first tranche, then stop at engineer approval.\n";
	writeFileSync(planPath, content);
	assert.equal(await h.event("tool_call", { toolName: "write", input: { path: planPath, content } }), undefined);
	assert.equal(await h.event("tool_call", { toolName: "bash", input: { command: "pwd; git status --short; ls -la" } }), undefined);
	assert.equal((await h.event("tool_call", { toolName: "bash", input: { command: "find . -delete" } })).block, true);
	assert.equal((await h.event("tool_call", { toolName: "powershell", input: { command: "ls" } })).block, true);
	const denial = await h.event("tool_call", { toolName: "write", input: { path: "/not-the-plan.md" } });
	assert.equal(denial.block, true);
	assert.ok(denial.reason.includes(planPath));
	for (const path of ["~/outside.md", "@~/outside.md", "file:///not-the-plan.md", "@/not-the-plan.md", "file:///not-the-plan\u00a0.md"]) {
		assert.equal((await h.event("tool_call", { toolName: "write", input: { path } })).block, true, path);
	}
	assert.equal(await h.event("tool_call", { toolName: "write", input: { path: pathToFileURL(planPath).href } }), undefined);
	assert.equal(await h.event("tool_call", { toolName: "write", input: { path: join(sandbox, "scratch.md") } }), undefined);

	// Symlinked scratch paths must not permit writes outside scratch space.
	symlinkSync(homedir(), join(sandbox, "outside"));
	assert.equal((await h.event("tool_call", { toolName: "write", input: { path: join(sandbox, "outside", "do-not-write.md") } })).block, true);
	symlinkSync(join(homedir(), `not-created-${Date.now()}.md`), join(sandbox, "dangling"));
	await assert.rejects(h.event("tool_call", { toolName: "write", input: { path: join(sandbox, "dangling") } }), /dangling symbolic links/);
	symlinkSync(homedir(), join(sandbox, "outside dir"));
	assert.equal((await h.event("tool_call", { toolName: "edit", input: { path: join(sandbox, "outside\u00a0dir", "do-not-write.md") } })).block, true);

	assert.equal((await h.exit()).details.choice, "refine");
	assert.equal(h.state().mode, "plan");
	assert.equal(h.state().pendingHandoff, false);
	assert.deepEqual(h.messages, []);
	h.ctx.mode = "rpc";
	assert.equal((await h.exit()).details.choice, "refine");
	h.ctx.mode = "tui";
	h.choose("Save plan and stop");
	assert.equal((await h.exit()).details.choice, "stop");
	assert.equal(h.state().mode, "plan");
	h.choose(undefined);
	assert.equal((await h.exit()).details.choice, "cancel");
	assert.equal(h.state().mode, "plan");

	h.ctx.hasUI = false;
	assert.equal((await h.exit()).details.choice, "awaiting-approval");
	assert.equal(h.state().mode, "plan");
	h.ctx.hasUI = true;
	h.choose("Implement here");
	h.onSelect(() => writeFileSync(planPath, content + "Changed during review."));
	await assert.rejects(h.exit(), /changed during review/);
	assert.equal(h.state().mode, "plan");
	h.onSelect(() => {});
	writeFileSync(planPath, content);
	assert.equal((await h.exit()).details.choice, "here");
	assert.equal(h.state().mode, "build");
	assert.equal(h.thinking(), "off");
	assert.equal(h.statuses.has("00-opencode-plan-mode"), false);
	await assert.rejects(h.exit(), /Enter Plan mode/);

	await h.command("plan");
	h.choose("Implement in a new session");
	const approval = await h.exit();
	assert.equal(approval.details.choice, "new-session");
	assert.equal(approval.terminate, true);
	assert.equal(h.state().mode, "plan");
	assert.equal(h.state().pendingHandoff, true);
	assert.equal(h.dispatched().length, 0, "handoff waits for agent_settled");
	await h.event("agent_settled", { aborted: false });
	assert.deepEqual(h.dispatched(), [{ content: "/plan-handoff", options: { expandPromptTemplates: true } }]);
	assert.equal(h.state().pendingHandoff, true);
	await h.event("agent_settled", { aborted: false });
	assert.equal(h.dispatched().length, 1, "automatic handoff is one-shot");
	writeFileSync(planPath, content + "Changed after approval.");
	await h.command("plan-handoff");
	assert.equal(h.state().pendingHandoff, false);
	assert.ok(h.notices.at(-1).includes("changed after approval"));
	assert.equal(h.prompts.length, 0);
	writeFileSync(planPath, content);
	await h.exit();
	await h.event("tool_call", { toolName: "edit", input: { path: `@${planPath}` } });
	assert.equal(h.state().pendingHandoff, false);
	await h.event("agent_settled", { aborted: false });
	assert.equal(h.dispatched().length, 1, "editing the approved plan cancels automatic handoff");
	await h.exit();
	h.cancelSession(true);
	await h.event("agent_settled", { aborted: false });
	await h.command("plan-handoff");
	await h.event("agent_settled", { aborted: false });
	assert.equal(h.dispatched().length, 2, "a cancelled switch must not automatically retry");
	assert.equal(h.state().pendingHandoff, true);
	assert.equal(h.prompts.length, 0);
	h.cancelSession(false);
	await h.command("plan-handoff");
	assert.equal(h.prompts.length, 1);
	assert.ok(h.prompts[0].includes(planPath));
	assert.ok(h.prompts[0].includes("stop at its approval gates"));
	assert.equal(h.newEntries()[0].data.mode, "build");
	assert.equal(h.newEntries()[0].data.previousThinking, "off");
	// Real Pi calls session_start before the command's setup callback.
	const fresh = await harness([], true);
	await fresh.event("session_start");
	assert.equal(fresh.thinking(), "high");
	fresh.setBranch([...fresh.entries(), ...h.newEntries()]);
	assert.equal((await fresh.event("before_agent_start")), undefined);
	assert.equal(fresh.state().mode, "build");
	assert.equal(fresh.thinking(), "off");

	// Normal fresh-session approval automatically dispatches the existing command.
	const auto = await harness();
	await auto.command("plan");
	writeFileSync(auto.state().planPath, content);
	auto.choose("Implement in a new session");
	await auto.exit();
	assert.equal(auto.prompts.length, 0);
	assert.equal(auto.ctx.newSession, undefined, "tools and events have no session replacement API");
	assert.equal((await auto.event("tool_call", { toolName: "write", input: { path: "/not-the-plan.md" } })).block, true);
	await auto.settle();
	assert.equal(auto.prompts.length, 1);
	assert.equal(auto.newEntries()[0].data.mode, "build");

	for (const invalidate of ["abort", "tree", "session", "build", "new-plan", "edit", "refine", "cancel", "stop", "drift"]) {
		const pending = await harness();
		await pending.command("plan");
		writeFileSync(pending.state().planPath, content);
		pending.choose("Implement in a new session");
		await pending.exit();
		if (invalidate === "tree") await pending.event("session_tree");
		if (invalidate === "session") await pending.event("session_start");
		if (invalidate === "build") await pending.command("build");
		if (invalidate === "new-plan") await pending.command("plan", "new other");
		if (invalidate === "edit") await pending.event("tool_call", { toolName: "edit", input: { path: pending.state().planPath } });
		if (["refine", "cancel", "stop"].includes(invalidate)) {
			pending.choose(invalidate === "refine" ? "Keep refining the plan" : invalidate === "stop" ? "Save plan and stop" : undefined);
			await pending.exit();
		}
		if (invalidate === "drift") writeFileSync(pending.state().planPath, content + "Changed before settlement.");
		await pending.settle(invalidate === "abort");
		await pending.settle();
		assert.equal(pending.prompts.length, 0, invalidate);
		assert.equal(pending.dispatched().length, invalidate === "drift" ? 1 : 0, invalidate);
	}
	const savedApproval = await harness(h.entries());
	await savedApproval.event("session_start");
	await savedApproval.settle();
	assert.equal(savedApproval.dispatched().length, 0, "restored pending approval must not auto-start");

	const vetoed = await harness();
	await vetoed.command("plan");
	writeFileSync(vetoed.state().planPath, content);
	vetoed.choose("Implement in a new session");
	await vetoed.exit();
	vetoed.cancelSession(true);
	await vetoed.settle();
	await vetoed.settle();
	assert.equal(vetoed.state().pendingHandoff, true);
	assert.equal(vetoed.state().mode, "plan");
	assert.equal(vetoed.prompts.length, 0);
	assert.equal(vetoed.dispatched().length, 1);
	vetoed.cancelSession(false);
	await vetoed.command("plan-handoff");
	assert.equal(vetoed.prompts.length, 1);

	const restored = await harness([{ type: "custom", customType: "opencode-plan-mode", data: { mode: "plan", previousThinking: "off" } }]);
	await restored.event("session_start");
	assert.ok(restored.state().planPath.startsWith(join(profile, "plans")));
	const attached = restored.state().planPath;
	await restored.command("plan", "new pilot");
	const firstNamed = restored.state().planPath;
	await restored.command("plan", "new pilot");
	assert.notEqual(restored.state().planPath, firstNamed);
	assert.notEqual(attached, firstNamed);
	const resumed = await harness(restored.entries());
	await resumed.event("session_start");
	assert.equal(resumed.state().planPath, restored.state().planPath);
	resumed.setBranch([]);
	await resumed.event("session_tree");
	assert.equal((await resumed.event("before_agent_start")), undefined);

	const flagged = await harness([], true);
	await flagged.event("session_start");
	assert.equal(flagged.state().mode, "plan");
	assert.ok(flagged.state().planPath);
	assert.equal(flagged.statuses.get("00-opencode-plan-mode"), "📐 plan");
	// Regression: Finding 3 — file_path param must be recognised by pathFrom
	{
		const r = await harness();
		await r.command("plan");
		const fp = r.state().planPath;
		writeFileSync(fp, content);
		// file_path allowed to plan path
		assert.equal(await r.event("tool_call", { toolName: "write", input: { file_path: fp } }), undefined, "file_path allowed to plan path");
		// file_path outside plan path must be blocked
		assert.equal((await r.event("tool_call", { toolName: "write", input: { file_path: "/not-the-plan.md" } })).block, true, "file_path outside plan must block");
	}

	// Regression: Finding 1 — unknown tool with path key must be blocked in plan mode
	{
		const r = await harness();
		await r.command("plan");
		// An unknown tool with no path key — must pass through (no block)
		assert.equal(await r.event("tool_call", { toolName: "future_read_tool", input: { query: "hello" } }), undefined, "unknown tool without path key must not block");
		// An unknown tool with a path key — must be blocked
		const unknownBlock = await r.event("tool_call", { toolName: "future_write_tool", input: { path: "/some/repo/file.ts" } });
		assert.equal(unknownBlock.block, true, "unknown tool with path key must block");
		assert.ok(unknownBlock.reason.includes("future_write_tool"), "block reason names the tool");
		// Known read-only tools with a path key must not be blocked
		assert.equal(await r.event("tool_call", { toolName: "read", input: { path: "/some/repo/file.ts" } }), undefined, "read tool must not be blocked");
	}

	// Regression: Finding 5 — bash branch with non-object input must fail closed
	{
		const r = await harness();
		await r.command("plan");
		const nullBlock = await r.event("tool_call", { toolName: "bash", input: null });
		assert.equal(nullBlock.block, true, "bash with null input must block");
		const strBlock = await r.event("tool_call", { toolName: "bash", input: "git status" });
		assert.equal(strBlock.block, true, "bash with string input must block");
	}

	// Step 4a — /plan-handoff with no pending handoff emits a notice and starts no session.
	{
		const r = await harness();
		await r.event("session_start"); // fresh build mode, no /plan run
		await r.command("plan-handoff");
		assert.equal(r.notices.at(-1), "No approved plan handoff is waiting.", "4a build-mode notice");
		assert.equal(r.prompts.length, 0, "4a build-mode no session replacement");
		assert.equal(r.newEntries().length, 0, "4a build-mode no handoff entries");
	}
	{
		const r = await harness();
		await r.command("plan"); // plan mode, but plan_exit never called so pendingHandoff stays false
		await r.command("plan-handoff");
		assert.equal(r.notices.at(-1), "No approved plan handoff is waiting.", "4a plan-mode notice");
		assert.equal(r.prompts.length, 0, "4a plan-mode no session replacement");
	}

	// Step 4b — the context event strips plan entries in build mode and passes through in plan mode.
	{
		const r = await harness();
		await r.event("session_start"); // build mode
		const normal = { role: "user", content: "keep me" };
		const planCtx = { customType: "opencode-plan-mode-context", content: "drop me" };
		const filtered = await r.event("context", { messages: [normal, planCtx] });
		assert.deepEqual(filtered.messages, [normal], "4b build mode strips plan-context message");
		await r.command("plan"); // switch to plan mode
		assert.equal(await r.event("context", { messages: [normal, planCtx] }), undefined, "4b plan mode passes context through unchanged");
	}

	// Step 4c — previousThinking is restored correctly across mode switches and session restores.
	{
		// 4c.1 — enter plan then /build restores the prior tier and clears previousThinking.
		const r = await harness();
		await r.event("session_start");
		assert.equal(r.thinking(), "off");
		await r.command("plan");
		assert.equal(r.thinking(), "high");
		await r.command("build");
		assert.equal(r.thinking(), "off", "4c.1 thinking restored to prior value");
		assert.equal(r.state().mode, "build");
		assert.equal(r.state().previousThinking, undefined, "4c.1 previousThinking cleared on build");
	}
	{
		// 4c.2 — persisted plan state restores to thinking "high" and mode "plan" on session_start.
		const r = await harness();
		await r.command("plan");
		assert.equal(r.thinking(), "high");
		const resumed = await harness(r.entries());
		await resumed.event("session_start");
		assert.equal(resumed.thinking(), "high", "4c.2 restored plan state sets thinking high");
		assert.equal(resumed.state().mode, "plan", "4c.2 restored mode is plan");
	}
	{
		// 4c.3 — after "Implement here" clears previousThinking, a session_tree restore keeps build with no dangling tier.
		const r = await harness();
		await r.command("plan");
		const pp = r.state().planPath;
		writeFileSync(pp, content);
		r.choose("Implement here");
		await r.exit();
		assert.equal(r.state().mode, "build");
		assert.equal(r.state().previousThinking, undefined, "4c.3 previousThinking cleared on Implement here");
		const resumed = await harness(r.entries());
		await resumed.event("session_tree");
		assert.equal(resumed.state().mode, "build", "4c.3 restored mode is build");
		assert.equal(resumed.state().previousThinking, undefined, "4c.3 no dangling previousThinking");
		assert.equal(resumed.thinking(), "off", "4c.3 thinking stays at harness default");
	}
	{
		// 4c.4 — a build-mode branch carrying a dangling previousThinking restores and clears it.
		const r = await harness([{ type: "custom", customType: "opencode-plan-mode", data: { mode: "build", previousThinking: "medium" } }]);
		await r.event("session_start");
		assert.equal(r.thinking(), "medium", "4c.4 dangling previousThinking applied via setThinkingLevel");
		assert.equal(r.state().mode, "build");
		assert.equal(r.state().previousThinking, undefined, "4c.4 dangling previousThinking cleared");
	}

	// Step 4d — writing the approved plan via the write tool clears stale approval state.
	{
		const r = await harness();
		await r.command("plan");
		const pp = r.state().planPath;
		writeFileSync(pp, content);
		r.choose("Implement in a new session");
		await r.exit();
		assert.equal(r.state().pendingHandoff, true, "4d approval pending before edit");
		assert.ok(r.state().approvedHash, "4d approvedHash set before edit");
		await r.event("tool_call", { toolName: "write", input: { path: pp, content } });
		assert.equal(r.state().pendingHandoff, false, "4d write clears pendingHandoff");
		assert.equal(r.state().approvedHash, undefined, "4d write clears approvedHash");
	}

	// Step 4e — an aborted agent_settled must not dispatch the automatic handoff.
	{
		const r = await harness();
		await r.command("plan");
		const pp = r.state().planPath;
		writeFileSync(pp, content);
		r.choose("Implement in a new session");
		await r.exit();
		await r.event("agent_settled", { aborted: true });
		assert.equal(r.dispatched().length, 0, "4e aborted settle dispatches no handoff");
		assert.equal(r.prompts.length, 0, "4e aborted settle starts no session");
	}

	// Step 4f — /plan new <name> resets approval state so a stale approval cannot carry over.
	{
		const r = await harness();
		await r.command("plan");
		const pp = r.state().planPath;
		writeFileSync(pp, content);
		r.choose("Implement in a new session");
		await r.exit();
		assert.equal(r.state().pendingHandoff, true, "4f approval pending before new plan");
		assert.ok(r.state().approvedHash, "4f approvedHash set before new plan");
		await r.command("plan", "new another-plan");
		assert.equal(r.state().pendingHandoff, false, "4f new plan clears pendingHandoff");
		assert.equal(r.state().approvedHash, undefined, "4f new plan clears approvedHash");
	}

	// Step 5 — /plan status is read-only and reports mode, plan, readiness, handoff, thinking, last action.
	{
		// 5a — build mode (no plan run yet).
		const r = await harness();
		await r.event("session_start");
		await r.command("plan", "status");
		const buildStatus = r.notices.at(-1);
		assert.ok(buildStatus.includes("Mode: build"), "5a status shows build mode");
		assert.ok(buildStatus.includes("Plan: none"), "5a status shows no plan");
		assert.ok(buildStatus.includes("no plan attached"), "5a status shows no plan readiness");
		assert.ok(buildStatus.includes("Pending handoff: no"), "5a status shows no pending handoff");
		assert.ok(buildStatus.includes("Last action: none"), "5a status shows no last action");
		assert.ok(buildStatus.includes("Thinking level: off"), "5a status shows thinking level");
		assert.equal(r.state(), undefined, "5a status writes no state");
		assert.equal(r.statuses.has("00-opencode-plan-mode"), false, "5a status does not enter plan mode");
	}
	{
		// 5b — plan mode with an empty (unsaved) plan.
		const r = await harness();
		await r.command("plan");
		const planPath = r.state().planPath;
		const lastAction = r.state().lastAction;
		await r.command("plan", "status");
		const emptyStatus = r.notices.at(-1);
		assert.ok(emptyStatus.includes("Mode: plan"), "5b status shows plan mode");
		assert.ok(emptyStatus.includes(planPath), "5b status shows the canonical plan path");
		assert.ok(emptyStatus.includes("not approval-ready"), "5b status shows unsaved plan");
		assert.ok(emptyStatus.includes("Thinking level: high"), "5b status shows high thinking");
		assert.ok(emptyStatus.includes("Last action: entered-plan"), "5b status shows entered-plan");
		assert.equal(r.state().planPath, planPath, "5b status does not reserve a new plan");
		assert.equal(r.state().lastAction, lastAction, "5b status does not change last action");
	}
	{
		// 5c — plan mode with a saved plan and a pending approval.
		const r = await harness();
		await r.command("plan");
		const planPath = r.state().planPath;
		writeFileSync(planPath, content);
		r.choose("Implement in a new session");
		await r.exit();
		await r.command("plan", "status");
		const savedStatus = r.notices.at(-1);
		assert.ok(savedStatus.includes("approval-ready"), "5c status shows approval-ready plan");
		assert.ok(savedStatus.includes("Pending handoff: yes"), "5c status shows pending handoff");
		assert.ok(savedStatus.includes("Approval hash: present"), "5c status shows approval hash present");
		assert.ok(savedStatus.includes("Last action: approved-new-session"), "5c status shows approved-new-session");
		assert.equal(r.state().pendingHandoff, true, "5c status leaves pending handoff intact");
	}

	// Step 6 — configurable scratch root via PI_PLAN_SCRATCH_DIR.
	{
		// 6a — a valid absolute scratch dir is created on entering plan mode and permits scratch writes there.
		const scratch = mkdtempSync("/tmp/pi-plan-scratch-");
		rmSync(scratch, { recursive: true, force: true }); // the extension must create it on entering plan mode
		process.env.PI_PLAN_SCRATCH_DIR = scratch;
		try {
			const r = await harness();
			await r.command("plan");
			assert.equal(existsSync(scratch), true, "6a scratch dir created on entering plan mode");
			const scratchFile = join(scratch, "notes.md");
			assert.equal(await r.event("tool_call", { toolName: "write", input: { path: scratchFile } }), undefined, "6a write allowed inside configured scratch dir");
			assert.equal((await r.event("tool_call", { toolName: "write", input: { path: "/tmp/outside-scratch.md" } })).block, true, "6a write outside configured scratch dir blocked");
			const ctxMsg = await r.event("before_agent_start");
			assert.ok(ctxMsg.message.content.includes(scratch), "6a instruction names the scratch dir");
		} finally {
			delete process.env.PI_PLAN_SCRATCH_DIR;
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	{
		// 6b — a relative PI_PLAN_SCRATCH_DIR fails closed: scratch writes rejected, canonical plan writes still work.
		process.env.PI_PLAN_SCRATCH_DIR = "relative/scratch";
		try {
			const r = await harness();
			await r.command("plan");
			const planPath = r.state().planPath;
			writeFileSync(planPath, content);
			assert.equal(await r.event("tool_call", { toolName: "write", input: { path: planPath } }), undefined, "6b canonical plan write still allowed");
			assert.equal((await r.event("tool_call", { toolName: "write", input: { path: "/tmp/anything.md" } })).block, true, "6b scratch writes fail closed with relative env");
			await r.command("plan", "status");
			assert.ok(r.notices.at(-1).includes("Scratch: disabled"), "6b status reports scratch disabled");
			const ctxMsg = await r.event("before_agent_start");
			assert.ok(ctxMsg.message.content.includes("Scratch writes are disabled"), "6b instruction reports scratch disabled");
		} finally {
			delete process.env.PI_PLAN_SCRATCH_DIR;
		}
	}
	{
		// 6c — a scratch dir overlapping the plan directory is rejected (fail closed).
		process.env.PI_PLAN_SCRATCH_DIR = join(profile, "plans");
		try {
			const r = await harness();
			await r.command("plan");
			await r.command("plan", "status");
			assert.ok(r.notices.at(-1).includes("overlaps the canonical plan directory"), "6c overlapping scratch root disabled");
		} finally {
			delete process.env.PI_PLAN_SCRATCH_DIR;
		}
	}

	// Step 7 — approval-history lastAction breadcrumbs (no new storage, no plan contents).
	{
		// 7a — Implement here records approved-here and survives resume.
		const r = await harness();
		await r.command("plan");
		const planPath = r.state().planPath;
		writeFileSync(planPath, content);
		r.choose("Implement here");
		await r.exit();
		assert.equal(r.state().mode, "build", "7a implement here returns to build");
		assert.equal(r.state().lastAction, "approved-here", "7a records approved-here");
		const resumed = await harness(r.entries());
		await resumed.event("session_start");
		assert.equal(resumed.state().lastAction, "approved-here", "7a lastAction survives resume");
		assert.equal(resumed.state().mode, "build", "7a resume keeps build mode");
	}
	{
		// 7b — Keep refining then Save plan and stop record refining then saved-stop.
		const r = await harness();
		await r.command("plan");
		const planPath = r.state().planPath;
		writeFileSync(planPath, content);
		r.choose("Keep refining the plan");
		await r.exit();
		assert.equal(r.state().lastAction, "refining", "7b records refining");
		r.choose("Save plan and stop");
		await r.exit();
		assert.equal(r.state().lastAction, "saved-stop", "7b records saved-stop");
		assert.equal(r.state().mode, "plan", "7b stays in plan mode");
	}
	{
		// 7c — a changed-plan handoff is rejected and records handoff-rejected.
		const r = await harness();
		await r.command("plan");
		const planPath = r.state().planPath;
		writeFileSync(planPath, content);
		r.choose("Implement in a new session");
		await r.exit();
		writeFileSync(planPath, content + "Changed after approval.");
		await r.command("plan-handoff");
		assert.equal(r.state().pendingHandoff, false, "7c rejected handoff clears pending");
		assert.equal(r.state().lastAction, "handoff-rejected", "7c records handoff-rejected");
		assert.equal(r.prompts.length, 0, "7c no session started on rejected handoff");
		assert.ok(r.notices.at(-1).includes("changed after approval"), "7c warns the plan changed");
	}
	{
		// 7d — a clean handoff records handoff-started on the new build-session entry.
		const r = await harness();
		await r.command("plan");
		const planPath = r.state().planPath;
		writeFileSync(planPath, content);
		r.choose("Implement in a new session");
		await r.exit();
		await r.command("plan-handoff");
		assert.equal(r.prompts.length, 1, "7d handoff starts the build session");
		assert.equal(r.newEntries()[0].data.lastAction, "handoff-started", "7d records handoff-started on new session entry");
		assert.equal(r.newEntries()[0].data.mode, "build", "7d new session is build mode");
	}

	console.log("Plan status, scratch root, and approval-history: /plan status read-only snapshot, PI_PLAN_SCRATCH_DIR absolute/relative/overlap handling, and lastAction breadcrumbs passed.");

	console.log("Plan lifecycle: canonical paths, save validation, four review choices, cancellation, drift, handoff, resume, and flags passed.");

	// Step 8 — chat-based approval via the input handler.
	{
		// 8a — an exact approval phrase with a saved plan flips to build and transforms the text.
		const r = await harness();
		await r.event("session_start");
		await r.command("plan");
		const planPath = r.state().planPath;
		writeFileSync(planPath, content);
		const result = await r.event("input", { text: "approved", source: "interactive" });
		assert.equal(result?.action, "transform", "8a action is transform");
		assert.ok(result?.text.includes(planPath), "8a transform text contains plan path");
		assert.ok(result?.text.toLowerCase().includes("implement"), "8a transform text contains implement");
		assert.equal(r.state().mode, "build", "8a mode flipped to build");
		assert.equal(r.state().lastAction, "approved-chat", "8a lastAction is approved-chat");
		assert.equal(r.statuses.has("00-opencode-plan-mode"), false, "8a plan status indicator cleared");
	}
	{
		// 8b — all trigger phrases in the allowlist are accepted; result is transform.
		const phrases = ["approve", "approve the plan", "approve and build", "go build", "build it", "ship it", "lgtm", "execute the plan", "implement the plan"];
		for (const phrase of phrases) {
			const r = await harness();
			await r.event("session_start");
			await r.command("plan");
			writeFileSync(r.state().planPath, content);
			const res = await r.event("input", { text: phrase, source: "interactive" });
			assert.equal(res?.action, "transform", `8b phrase '${phrase}' accepted`);
		}
	}
	{
		// 8c — ambiguous and substring phrases do NOT trigger approval.
		const nonPhrases = ["proceed", "yes", "ok", "go ahead", "go", "let's go", "please approve and build later", "not approved", "don't build", "do not build yet", "i said approved to the other request"];
		for (const phrase of nonPhrases) {
			const r = await harness();
			await r.event("session_start");
			await r.command("plan");
			writeFileSync(r.state().planPath, content);
			const res = await r.event("input", { text: phrase, source: "interactive" });
			assert.ok(res?.action === "continue" || res === undefined, `8c phrase '${phrase}' must not trigger approval (got action '${res?.action}')`);
			assert.equal(r.state().mode, "plan", `8c phrase '${phrase}' must not exit plan mode`);
		}
	}
	{
		// 8d — approval phrase with no saved plan leaves Plan mode active (plan not ready).
		const r = await harness();
		await r.event("session_start");
		await r.command("plan");
		// intentionally do NOT write any content to planPath
		const res = await r.event("input", { text: "approved", source: "interactive" });
		assert.ok(res?.action === "continue" || res === undefined, "8d no plan: action is continue");
		assert.equal(r.state().mode, "plan", "8d no plan: stays in plan mode");
	}
	{
		// 8e — extension-source input is ignored even for an exact phrase with a saved plan.
		const r = await harness();
		await r.event("session_start");
		await r.command("plan");
		writeFileSync(r.state().planPath, content);
		const res = await r.event("input", { text: "approved", source: "extension" });
		assert.ok(res?.action === "continue" || res === undefined, "8e extension source ignored");
		assert.equal(r.state().mode, "plan", "8e extension source does not exit plan mode");
	}
	{
		// 8f — input handler is a no-op in build mode (does not accidentally affect non-plan sessions).
		const r = await harness();
		await r.event("session_start"); // build mode
		const res = await r.event("input", { text: "approved", source: "interactive" });
		assert.ok(res?.action === "continue" || res === undefined, "8f build mode is a no-op");
	}

	console.log("Chat-based approval: input handler, allowlist, source guard, and no-plan guard passed.");

	// Mitigation 1 — registry cross-check: every Pi built-in tool whose JSON Schema
	// exposes a path parameter must be classified in WRITE_TOOLS or READ_ONLY_TOOLS,
	// otherwise a future path-bearing tool could slip through the plan-mode gate.
	// Approach: load Pi's real built-in tool definitions via createAllToolDefinitions
	// (dist/core/tools/index.js) and inspect each definition's parameters.properties.
	{
		const { createAllToolDefinitions } = await import(pathToFileURL(join(dirname(loader), "../tools/index.js")).href);
		const definitions = createAllToolDefinitions(sandbox);
		const pathKeys = ["path", "file_path", "filePath"];
		let checked = 0;
		for (const definition of Object.values(definitions) as any[]) {
			const properties = definition.parameters?.properties ?? {};
			if (!pathKeys.some((key) => key in properties)) continue;
			checked++;
			assert.ok(WRITE_TOOLS.has(definition.name) || READ_ONLY_TOOLS.has(definition.name),
				`Tool '${definition.name}' has a path parameter but is not in WRITE_TOOLS or READ_ONLY_TOOLS`);
		}
		assert.ok(checked > 0, "registry cross-check found no path-bearing built-in tools to verify");
	}

	// Mitigation 2a — path expansion parity: writePath() must resolve exactly like
	// Pi's real resolveToCwd (dist/core/tools/path-utils.js), which writePath mirrors.
	{
		const { resolveToCwd } = await import(pathToFileURL(join(dirname(loader), "../tools/path-utils.js")).href);
		const cwd = "/tmp/test-cwd";
		const inputs = ["/foo/bar.md", "notes.md", "subdir/notes.md", "~/documents/plan.md", "@plan.md", "file:///tmp/plan.md", "plan\u00a0notes.md"];
		for (const input of inputs) {
			const ours = writePath(input, cwd);
			const theirs = resolveToCwd(input, cwd);
			assert.equal(ours, theirs, `writePath diverged from Pi for input '${input}': got '${ours}', Pi returned '${theirs}'`);
		}
	}

	// Mitigation 2b — version pin: if the installed Pi version no longer matches the
	// version pinned in index.ts's writePath() comment, fail loudly so the path logic
	// is re-reviewed against the new dist before the pin is bumped.
	{
		const piPackage = JSON.parse(readFileSync(join(piModules, "@earendil-works/pi-coding-agent/package.json"), "utf8"));
		const pinned = readFileSync(source, "utf8").match(/pi-coding-agent v(\d+\.\d+\.\d+)/)?.[1];
		assert.equal(piPackage.version, pinned,
			`Pi version changed to ${piPackage.version} — review writePath() and pathFrom() against the new dist/utils/paths.js and dist/core/tools/path-utils.js, then update the pinned version in the comment.`);
	}

	console.log("Mitigations: registry cross-check, path-expansion parity, and version pin passed.");
} finally {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(sandbox, { recursive: true, force: true });
}
