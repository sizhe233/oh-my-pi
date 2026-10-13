import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	AgentBusyError,
	type AgentMessage,
	type AgentTool,
	ASIDE_MESSAGE_COMMIT,
} from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as persistedRoster from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import { hasRestorableTurn } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as subSessions from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import type { SubSession } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { isTerminalYieldResult } from "@oh-my-pi/pi-coding-agent/task/yield-result";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function entry(message: AgentMessage): SessionEntry {
	return { type: "message", id: "message", parentId: null, timestamp: new Date().toISOString(), message };
}
function appendFixtureMessages(memory: SessionManager, entries: SessionEntry[]): void {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
			throw new Error(`Unexpected fixture message role: ${message.role}`);
		}
		memory.appendMessage(message);
	}
}
const user = entry({ role: "user", content: "work", timestamp: 1 });
const assistant = (content: string | { id: string; name: string }): SessionEntry =>
	entry({
		role: "assistant",
		content:
			typeof content === "string"
				? [{ type: "text", text: content }]
				: [{ type: "toolCall", ...content, arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		usage: zeroUsage,
		stopReason: typeof content === "string" ? "stop" : "toolUse",
		timestamp: 1,
	});
const cutOff = [user, assistant({ id: "r", name: "read" })];
const done = [user, assistant("done")];
function yieldTail(details: Record<string, unknown>, isError = false): SessionEntry[] {
	return [
		user,
		assistant({ id: "y", name: "yield" }),
		entry({
			role: "toolResult",
			toolCallId: "y",
			toolName: "yield",
			content: [{ type: "text", text: "submitted" }],
			details,
			isError,
			timestamp: 1,
		}),
	];
}
const result = (id: string): SingleResult => ({
	index: 0,
	id,
	agent: id,
	agentSource: "user",
	task: "work",
	exitCode: 0,
	output: id,
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 0,
	requests: 1,
});
async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Expected restore transition did not occur");
		await Bun.sleep(1);
	}
}
let manager: AsyncJobManager;
let registry: AgentRegistry;
let lifecycle: AgentLifecycleManager;
let tempDir: TempDir;
let mainFile: string;
beforeEach(() => {
	tempDir = TempDir.createSync("@pi-restore-queue-");
	mainFile = path.join(tempDir.path(), "root.jsonl");
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
	lifecycle = AgentLifecycleManager.global();
	manager = new AsyncJobManager({ maxRunningJobs: 1 });
	vi.spyOn(persistedRoster, "ensurePersistedRoster").mockResolvedValue(mainFile);
});
afterEach(async () => {
	manager.cancelAll();
	await manager.dispose({ timeoutMs: 1_000 });
	await lifecycle.dispose();
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	tempDir.removeSync();
});
function fixture(tree: Record<string, SessionEntry[]>) {
	const subs: Record<string, SubSession> = {};
	for (const [key, messages] of Object.entries(tree)) {
		const id = key.split("/").at(-1)!;
		const parent = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : null;
		subs[key] = {
			agentId: id,
			parent,
			header: null,
			leafId: null,
			aborted: false,
			malformedRecords: 0,
			entries: [
				{
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: new Date().toISOString(),
					systemPrompt: ["test"],
					task: `${id} task`,
					tools: ["read", "yield"],
				},
				...messages,
			],
		};
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: parent?.split("/").at(-1) ?? "Main",
			session: null,
			status: "parked",
			sessionFile: path.join(mainFile.slice(0, -6), `${key}.jsonl`),
		});
	}
	vi.spyOn(subSessions, "collectSubSessions").mockResolvedValue(subs);
	const restoreTurn = vi.fn(async () => true);
	const root = {
		sessionManager: { getSessionFile: () => mainFile },
		getAgentId: () => "Main",
		asyncJobManager: manager,
		settings: Settings.isolated(),
		yieldQueue: { holdIdleFlush: () => () => {} },
		waitForIdle: async () => {},
		restoreInterruptedTurn: restoreTurn,
	} as unknown as AgentSession;
	return { root, restoreTurn, subs };
}
function installOwner(ttl: number, delivered: string[], receipt = Promise.resolve()) {
	lifecycle.setPersistedSubagentReviverFactory(
		async ref => async () => {
			const unregister = manager.registerDeliverySink(ref.id, async id => {
				delivered.push(id);
				await receipt;
			});
			return {
				asyncJobManager: manager,
				isStreaming: false,
				yieldQueue: { holdIdleFlush: () => () => {} },
				sessionManager: { getUsageStatistics: () => ({ cost: 0, subagentCost: 0 }) },
				waitForIdle: async () => {},
				hasPendingAsyncWork: () => manager.hasPendingDeliveries({ ownerId: ref.id }),
				settleAsyncWork: async () => {
					await manager.waitForOwnerJobs(ref.id);
					await manager.drainDeliveries({ filter: { ownerId: ref.id } });
				},
				dispose: async () => {
					unregister();
					manager.cancelAll({ ownerId: ref.id });
				},
			} as unknown as AgentSession;
		},
		() => ttl,
	);
}
it("stages a restore above an already-full cap, resumes root, and never executes a cancelled queued child", async () => {
	const blocked = Promise.withResolvers<string>();
	manager.register("task", "existing", () => blocked.promise, { id: "existing" });
	const { root, restoreTurn } = fixture({ A: cutOff, B: cutOff });
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	const restored = await restoreSession(root);
	expect(restored.subagents).toEqual(["A", "B"]);
	expect(restoreTurn).toHaveBeenCalledTimes(1);
	expect(manager.getJob("A")?.queued).toBe(true);
	expect(() => manager.register("task", "normal", async () => "")).toThrow("limit reached");
	manager.cancel("B");
	blocked.resolve("existing");
	await manager.waitForAll();
	expect(followUp.mock.calls.map(call => call[0].id)).toEqual(["A"]);
	expect(manager.getJob("B")?.status).toBe("cancelled");
});
it("lets the descendant finish before its interrupted parent claims the only running slot", async () => {
	const { root } = fixture({ Parent: cutOff, "Parent/Child": cutOff });
	const delivered: string[] = [];
	installOwner(0, delivered);
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	await restoreSession(root);
	await manager.waitForAll();
	await manager.drainDeliveries();
	expect(followUp.mock.calls.map(call => call[0].id)).toEqual(["Child", "Parent"]);
	expect(delivered).toEqual(["Child"]);
});
it("keeps the owner alive until the child's delivery receipt, then restores its TTL", async () => {
	const { root } = fixture({ Parent: done, "Parent/Child": cutOff });
	const work = Promise.withResolvers<SingleResult>();
	const receipt = Promise.withResolvers<void>();
	const delivered: string[] = [];
	installOwner(5, delivered, receipt.promise);
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockReturnValue(work.promise);
	const restored = await restoreSession(root);
	expect(restored.subagents).toEqual(["Parent", "Child"]);
	await Bun.sleep(15);
	expect(registry.get("Parent")?.session).not.toBeNull();
	work.resolve(result("Child"));
	await manager.getJob("Child")!.promise;
	await Bun.sleep(15);
	expect(registry.get("Parent")?.session).not.toBeNull();
	expect(delivered).toEqual(["Child"]);
	expect(followUp.mock.calls.map(call => call[0].id)).toEqual(["Child", "Parent"]);
	receipt.resolve();
	await waitUntil(() => registry.get("Parent")?.status === "parked");
});
it("cancels a queued restore instead of delivering to a replacement owner generation", async () => {
	const blocked = Promise.withResolvers<string>();
	manager.register("task", "existing", () => blocked.promise, { id: "existing" });
	const { root } = fixture({ Parent: done, "Parent/Child": cutOff });
	const delivered: string[] = [];
	installOwner(0, delivered);
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	await restoreSession(root);
	const ref = registry.get("Parent")!;
	registry.unregister("Parent", ref);
	registry.register({
		id: "Parent",
		displayName: "replacement",
		kind: "sub",
		parentId: "Main",
		session: null,
		sessionFile: "/other/root/Parent.jsonl",
		status: "parked",
	});
	blocked.resolve("existing");
	await manager.waitForAll();
	expect(followUp).not.toHaveBeenCalled();
	expect(manager.getJob("Child")?.status).toBe("cancelled");
	expect(delivered).toEqual([]);
});
it("does not replay completed terminal/workpool yields but retains incremental and rejected yields", () => {
	for (const [details, isError, restorable] of [
		[{ status: "success" }, false, false],
		[{ status: "success", type: ["section"] }, false, true],
		[{ status: "success", type: ["item"], complete: true }, false, false],
		[{ status: "success", type: ["item"], complete: false }, false, true],
		[{ status: "aborted" }, false, false],
		[{ status: "success" }, true, true],
	] as const) {
		expect(hasRestorableTurn(yieldTail(details, isError))).toBe(restorable);
		expect(isTerminalYieldResult({ isError, result: { details } })).toBe(!restorable);
	}
});
it("restores an unfinished child of a terminal-yield owner without replaying the completed yield", async () => {
	const { root } = fixture({
		Done: yieldTail({ status: "success" }),
		Parent: yieldTail({ status: "success" }),
		"Parent/Child": cutOff,
	});
	const delivered: string[] = [];
	installOwner(0, delivered);
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	const restored = await restoreSession(root);
	await manager.waitForAll();
	await manager.drainDeliveries();
	expect(restored.subagents).toEqual(["Parent", "Child"]);
	expect(followUp.mock.calls.map(call => call[0].id)).toEqual(["Child"]);
	expect(delivered).toEqual(["Child"]);
});

it.each([false, true])(
	"replays interrupted parent and child batches with a scheduled continuation collision=%s",
	async collision => {
		const pending = [user, assistant({ id: "probe", name: "probe" })];
		const { root, subs } = fixture({ Parent: pending, "Parent/Child": pending });
		for (const sub of Object.values(subs)) {
			const init = sub.entries[0]!;
			if (init.type === "session_init") init.tools = ["probe"];
		}
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const auth = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(auth);
		const executed: string[] = [];
		const collisions: string[] = [];
		const sessions: AgentSession[] = [];
		lifecycle.setPersistedSubagentReviverFactory(
			async ref => async () => {
				const memory = SessionManager.inMemory();
				const sub = Object.values(subs).find(value => value.agentId === ref.id)!;
				appendFixtureMessages(memory, sub.entries);
				const mock = createMockModel({ handler: () => ({ content: [`finished ${ref.id}`], stopReason: "stop" }) });
				const probe: AgentTool = {
					name: "probe",
					label: "Probe",
					description: "In-memory probe",
					parameters: type({}),
					async execute() {
						executed.push(ref.id);
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				};
				const agent = new Agent({
					getApiKey: () => "in-memory-test-key",
					streamFn: mock.stream,
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [probe],
						messages: memory.buildSessionContext().messages,
					},
				});
				const session = new AgentSession({
					agent,
					sessionManager: memory,
					agentId: ref.id,
					agentKind: "sub",
					asyncJobManager: manager,
					modelRegistry,
					settings: Settings.isolated({
						"compaction.enabled": false,
						"retry.enabled": false,
						"advisor.enabled": false,
						"todo.enabled": false,
					}),
				});
				session.subscribe(() => {});
				if (collision && ref.id === "Parent") {
					// The real public restore path schedules continue; its recovery
					// handler owns a late busy collision instead of rejecting restore.
					vi.spyOn(agent, "continue").mockImplementationOnce(async () => {
						collisions.push(ref.id);
						throw new AgentBusyError();
					});
				}
				executor.attachIrcWakeTurnMonitor(session, {
					id: ref.id,
					agent: { name: ref.id, description: "", systemPrompt: "Test", source: "user" },
					structured: false,
				});
				sessions.push(session);
				return session;
			},
			() => 0,
		);
		try {
			await restoreSession(root);
			await manager.waitForAll();
			await manager.drainDeliveries();
			expect(executed).toEqual(["Child", "Parent"]);
			expect(collisions).toEqual(collision ? ["Parent"] : []);
			expect(manager.getJob("Parent")?.status).toBe("completed");
		} finally {
			for (const session of sessions) await session.dispose();
			auth.close();
		}
	},
	10_000,
);

it("replays an interrupted Main batch before a fast child's result can replace its tail", async () => {
	const pending = [user, assistant({ id: "probe", name: "probe" })];
	const { subs } = fixture({ Child: pending });
	const init = subs.Child!.entries[0]!;
	if (init.type === "session_init") init.tools = ["probe"];
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing test model");
	const auth = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(auth);
	const executed: string[] = [];
	const sessions: AgentSession[] = [];
	const create = (id: string) => {
		const memory = SessionManager.inMemory();
		appendFixtureMessages(memory, pending);
		const mock = createMockModel({ handler: () => ({ content: [`finished ${id}`], stopReason: "stop" }) });
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "In-memory probe",
			parameters: type({}),
			async execute() {
				executed.push(id);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const agent = new Agent({
			getApiKey: () => "in-memory-test-key",
			streamFn: mock.stream,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [probe],
				messages: memory.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: memory,
			agentId: id,
			agentKind: id === "Main" ? "main" : "sub",
			asyncJobManager: manager,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"todo.enabled": false,
			}),
		});
		session.subscribe(() => {});
		sessions.push(session);
		return session;
	};
	const root = create("Main");
	vi.spyOn(root.sessionManager, "getSessionFile").mockReturnValue(mainFile);
	lifecycle.setPersistedSubagentReviverFactory(
		async ref => async () => create(ref.id),
		() => 0,
	);
	try {
		const restored = await restoreSession(root);
		expect(restored.turn).toBe(true);
		await manager.waitForAll();
		await root.settleAsyncWork();
		await root.waitForIdle();
		expect([...executed].sort()).toEqual(["Child", "Main"]);
		expect(
			root.agent.state.messages.filter(message => message.role === "user" && message.content === "work"),
		).toHaveLength(1);
	} finally {
		for (const session of sessions) await session.dispose();
		auth.close();
	}
}, 10_000);

it("atomically admits only the configured number of staged jobs on a shared capacity wakeup", async () => {
	const first = Promise.withResolvers<string>();
	manager.register("task", "first", () => first.promise);
	const release = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	const started: string[] = [];
	for (const id of ["A", "B", "C"]) {
		manager.register(
			"task",
			id,
			async () => {
				started.push(id);
				active++;
				peak = Math.max(peak, active);
				await release.promise;
				active--;
				return id;
			},
			{ id, waitForCapacity: true },
		);
	}
	first.resolve("first");
	await waitUntil(() => started.length === 1);
	expect(
		manager
			.getRunningJobs()
			.filter(job => !job.queued)
			.map(job => job.id),
	).toEqual(["A"]);
	release.resolve();
	await manager.waitForAll();
	expect(started).toEqual(["A", "B", "C"]);
	expect(peak).toBe(1);
});

it("disposal aborts both queued capacity and abort-aware dependency waits before their bodies execute", async () => {
	const run = vi.fn(async () => "unexpected");
	manager.register("task", "first", ({ signal }) => untilAborted(signal, Promise.withResolvers<string>().promise));
	manager.register("task", "capacity", run, { waitForCapacity: true });
	manager.register("task", "dependency", run, {
		waitForCapacity: true,
		beforeStart: signal => untilAborted(signal, Promise.withResolvers<void>().promise),
	});
	await manager.dispose({ timeoutMs: 1_000 });
	expect(run).not.toHaveBeenCalled();
	expect(manager.getAllJobs()).toEqual([]);
});

it("explicit kill overrides a delivery hold, while an old hold cannot alter a replacement generation", async () => {
	const { root } = fixture({ Parent: done, "Parent/Child": cutOff });
	const delivered: string[] = [];
	installOwner(5, delivered);
	vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ signal }) => {
		await untilAborted(signal!, Promise.withResolvers<void>().promise);
		return result("Child");
	});
	await restoreSession(root);
	await waitUntil(() => manager.getJob("Child")?.queued === false);
	const ref = registry.get("Parent")!;
	const staleRelease = lifecycle.hold("Parent", ref);
	// This fixture has no on-disk transcript; the real in-process tombstone
	// transition still runs, while disk sidecars are covered by restore.test.ts.
	ref.sessionFile = null;
	await lifecycle.release("Parent", ref, { tombstone: true });
	await manager.getJob("Child")!.promise;
	expect(ref.status).toBe("aborted");
	expect(ref.session).toBeNull();
	expect(manager.getJob("Child")?.status).toBe("cancelled");
	registry.unregister("Parent", ref);
	const dispose = vi.fn(async () => {});
	const replacement = registry.register({
		id: "Parent",
		kind: "sub",
		displayName: "replacement",
		session: { dispose } as unknown as AgentSession,
		status: "idle",
		sessionFile: null,
	});
	const released = vi.fn(async () => {});
	lifecycle.adopt("Parent", { idleTtlMs: 5, onRelease: released }, replacement);
	staleRelease();
	staleRelease();
	await waitUntil(() => replacement.status === "parked");
	expect(dispose).toHaveBeenCalledTimes(1);
	await lifecycle.release("Parent", replacement);
	expect(released).toHaveBeenCalledTimes(1);
});

it("releases delivery holds if manager disposal races owner revival before registration", async () => {
	const { root } = fixture({ Parent: done, "Parent/Child": cutOff });
	installOwner(5, []);
	const ensure = lifecycle.ensureLive.bind(lifecycle);
	vi.spyOn(lifecycle, "ensureLive").mockImplementation(async id => {
		const session = await ensure(id);
		await manager.dispose({ timeoutMs: 100 });
		return session;
	});
	await expect(restoreSession(root)).rejects.toThrow("disposed");
	await waitUntil(() => registry.get("Parent")?.status === "parked");
});

it("does not revive descendants through killed, isolated, missing-contract or foreign owners", async () => {
	for (const block of ["killed", "isolated", "missing", "foreign"] as const) {
		registry.unregister("Parent");
		registry.unregister("Child");
		const { root, subs } = fixture({ Parent: done, "Parent/Child": cutOff });
		if (block === "killed") subs.Parent!.aborted = true;
		if (block === "isolated") {
			const init = subs.Parent!.entries[0]!;
			if (init.type === "session_init") init.isolated = true;
		}
		if (block === "missing") subs.Parent!.entries.shift();
		if (block === "foreign") registry.get("Parent")!.sessionFile = "/other/Parent.jsonl";
		const restored = await restoreSession(root);
		expect(restored.subagents).toEqual([]);
		expect(manager.getJob("Child")).toBeUndefined();
	}
});

it("keeps queued follow-up receipts pending across nested idle holds and releases them once", async () => {
	let streaming = false;
	const scheduled: Array<() => Promise<void>> = [];
	const injected: AgentMessage[] = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		scheduleIdleFlush: run => scheduled.push(run),
		injectIdle: async messages => {
			injected.push(...messages);
			for (const message of messages)
				(message as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
		},
		injectStreaming: message => {
			injected.push(message);
			(message as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
		},
	});
	queue.register<string>("result", { build: entries => ({ role: "user", content: entries.join(","), timestamp: 1 }) });
	const first = queue.holdIdleFlush();
	const second = queue.holdIdleFlush();
	let consumed = false;
	const receipt = queue.enqueueWithReceipt("result", "child").then(() => {
		consumed = true;
	});
	await queue.flush("idle");
	expect(consumed).toBe(false);
	expect(queue.hasDeliverable("result")).toBe(true);
	first();
	first();
	expect(scheduled).toHaveLength(0);
	second();
	expect(scheduled).toHaveLength(1);
	await scheduled[0]!();
	await receipt;
	expect(injected).toHaveLength(1);
	expect(consumed).toBe(true);
	const third = queue.holdIdleFlush();
	streaming = true;
	const streamingReceipt = queue.enqueueWithReceipt("result", "streaming child");
	await queue.flush("streaming");
	await streamingReceipt;
	third();
	expect(injected).toHaveLength(2);
});

it("propagates a child's result through terminal ancestors under cap one without replay or duplicate jobs", async () => {
	const pending = [user, assistant({ id: "probe", name: "probe" })];
	const { root, subs } = fixture({
		Grand: yieldTail({ status: "success", data: "old Grand" }),
		"Grand/Parent": yieldTail({ status: "success", data: "old Parent" }),
		"Grand/Parent/Child": pending,
	});
	const childInit = subs["Grand/Parent/Child"]!.entries[0]!;
	if (childInit.type === "session_init") childInit.tools = ["probe"];
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing test model");
	const auth = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(auth);
	const executed: string[] = [];
	const prompts: string[] = [];
	const sessions: AgentSession[] = [];
	const delivered: string[] = [];
	manager.registerDeliverySink("Main", id => {
		delivered.push(id);
	});
	lifecycle.setPersistedSubagentReviverFactory(
		async ref => async () => {
			const memory = SessionManager.inMemory();
			const sub = Object.values(subs).find(value => value.agentId === ref.id)!;
			appendFixtureMessages(memory, sub.entries);
			const mock = createMockModel({
				handler: () =>
					ref.id === "Child"
						? { content: ["child result"] }
						: { content: [{ type: "toolCall", name: "yield", arguments: { data: `new ${ref.id}` } }] },
			});
			const probe: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "In-memory probe",
				parameters: type({}),
				async execute() {
					executed.push(ref.id);
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
			const yieldParameters = type({ data: "string" });
			const yieldTool: AgentTool<typeof yieldParameters> = {
				name: "yield",
				label: "Yield",
				description: "In-memory result",
				parameters: yieldParameters,
				async execute(_call, args) {
					executed.push(String(args.data));
					return {
						content: [{ type: "text", text: "submitted" }],
						details: { status: "success", data: args.data, type: "result" },
					};
				},
			};
			const agent = new Agent({
				getApiKey: () => "in-memory-test-key",
				streamFn: mock.stream,
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: ref.id === "Child" ? [probe] : [yieldTool],
					messages: memory.buildSessionContext().messages,
				},
			});
			const session = new AgentSession({
				agent,
				sessionManager: memory,
				agentId: ref.id,
				agentKind: "sub",
				asyncJobManager: manager,
				modelRegistry,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					"advisor.enabled": false,
					"todo.enabled": false,
				}),
			});
			session.subscribe(() => {});
			const realPrompt = session.prompt.bind(session);
			vi.spyOn(session, "prompt").mockImplementation((text, options) => {
				prompts.push(text);
				return realPrompt(text, options);
			});
			executor.attachIrcWakeTurnMonitor(session, {
				id: ref.id,
				agent: { name: ref.id, description: "", systemPrompt: "Test", source: "user" },
				structured: ref.id !== "Child",
			});
			sessions.push(session);
			return session;
		},
		() => 5,
	);
	try {
		const restored = await restoreSession(root);
		await manager.waitForAll();
		await manager.drainDeliveries();
		expect(restored.subagents).toEqual(["Grand", "Parent", "Child"]);
		expect(executed).toEqual(["Child", "new Parent", "new Grand"]);
		expect(prompts).toEqual([]);
		expect(
			manager
				.getAllJobs()
				.map(job => job.id)
				.sort(),
		).toEqual(["Child", "Grand", "Parent"]);
		expect(manager.getJob("Child")?.ownerId).toBe("Parent");
		expect(manager.getJob("Parent")?.ownerId).toBe("Grand");
		expect(delivered).toEqual(["Grand"]);
	} finally {
		for (const session of sessions) await session.dispose();
		auth.close();
	}
}, 10_000);

it("cancels the staged subtree before admission without prompting terminal owners or leaking their holds", async () => {
	const blocked = Promise.withResolvers<string>();
	manager.register("task", "existing", () => blocked.promise, { id: "existing" });
	const { root } = fixture({ Grand: done, "Grand/Parent": done, "Grand/Parent/Child": cutOff });
	installOwner(5, []);
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	await restoreSession(root);
	expect(manager.cancel("Grand")).toBe(true);
	blocked.resolve("existing");
	await manager.waitForAll();
	expect(followUp).not.toHaveBeenCalled();
	for (const id of ["Grand", "Parent", "Child"]) expect(manager.getJob(id)?.status).toBe("cancelled");
	await waitUntil(() => registry.get("Grand")?.status === "parked" && registry.get("Parent")?.status === "parked");
});
