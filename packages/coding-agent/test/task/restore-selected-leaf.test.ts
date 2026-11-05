import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as persistedRoster from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { INTERRUPTED_TURN_ERROR } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { resolveSessionLeafId, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as subSessions from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import type { SubSession } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const mainFile = path.resolve("selected-leaf-fixture/root.jsonl");
let manager: AsyncJobManager;
let registry: AgentRegistry;
let lifecycle: AgentLifecycleManager;
beforeEach(() => {
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
});
function entry(message: AgentMessage): SessionEntry {
	return { type: "message", id: "message", parentId: null, timestamp: new Date().toISOString(), message };
}
const user = entry({ role: "user", content: "work", timestamp: 1 });
const assistant = (content: string | { id: string; name: string }): SessionEntry => {
	const message = createAssistantMessage(typeof content === "string" ? content : "");
	if (typeof content !== "string") {
		message.content = [{ type: "toolCall", ...content, arguments: {} }];
		message.stopReason = "toolUse";
	}
	return entry(message);
};
const cutOff = [user, assistant({ id: "read-call", name: "read" })];
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
function fixture(tree: Record<string, SessionEntry[]>) {
	const subs: Record<string, SubSession> = {};
	for (const [id, messages] of Object.entries(tree)) {
		const entries: SessionEntry[] = [
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
		];
		const linked = entries.map((entry, index) => ({
			...entry,
			id: `${id}-${index}`,
			parentId: index ? `${id}-${index - 1}` : null,
		}));
		subs[id] = {
			agentId: id,
			parent: null,
			header: null,
			leafId: linked.at(-1)!.id,
			entries: linked,
			aborted: false,
			malformedRecords: 0,
		};
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
			sessionFile: path.join(mainFile.slice(0, -6), `${id}.jsonl`),
		});
	}
	vi.spyOn(subSessions, "collectSubSessions").mockResolvedValue(subs);
	const root = {
		sessionManager: { getSessionFile: () => mainFile },
		getAgentId: () => "Main",
		asyncJobManager: manager,
		settings: Settings.isolated(),
		yieldQueue: { holdIdleFlush: () => () => {} },
		waitForIdle: async () => {},
		restoreInterruptedTurn: async () => false,
	} as unknown as AgentSession;
	return { root, subs };
}

it.each([
	"completed-selected",
	"interrupted-selected",
	"null-leaf",
	"missing-leaf",
	"cycle",
	"missing-parent",
] as const)("restores only the selected ancestry: %s", async selection => {
	const { root, subs } = fixture({ Child: cutOff });
	const sub = subs.Child!;
	const interruptedId = sub.leafId!;
	const completed = { ...assistant("completed sibling"), id: "completed", parentId: sub.entries[1]!.id };
	sub.entries.push(completed);
	if (selection === "completed-selected") {
		sub.leafId = completed.id;
		sub.entries.push({
			...assistant({ id: "abandoned", name: "read" }),
			id: "abandoned",
			parentId: sub.entries[1]!.id,
		});
	} else if (selection === "interrupted-selected") sub.leafId = interruptedId;
	else if (selection === "null-leaf") sub.leafId = null;
	else if (selection === "missing-leaf") sub.leafId = "not-in-transcript";
	else sub.entries[2]!.parentId = selection === "cycle" ? interruptedId : "missing-parent";
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	const restored = await restoreSession(root);
	await manager.waitForAll();
	const expected = selection === "interrupted-selected" ? ["Child"] : [];
	expect(restored.subagents).toEqual(expected);
	expect(followUp.mock.calls.map(call => call[0].id)).toEqual(expected);
});

it("selected ancestry does not discard the latest off-branch session_init revival contract", async () => {
	const { root, subs } = fixture({ Child: cutOff });
	const initial = subs.Child!.entries[0]!;
	if (initial.type !== "session_init") throw new Error("Expected init fixture");
	subs.Child!.entries.push({ ...initial, id: "latest-init", parentId: null, task: "latest persisted task" });
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	expect((await restoreSession(root)).subagents).toEqual(["Child"]);
	await manager.waitForAll();
	expect(followUp.mock.calls[0]![0].message).toBe("latest persisted task");
});

async function verifyRestore(root: AgentSession, expected: boolean): Promise<void> {
	const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async ({ id }) => result(id));
	expect((await restoreSession(root)).subagents).toEqual(expected ? ["Child"] : []);
	await manager.waitForAll();
	expect(followUp.mock.calls.map(call => call[0].id)).toEqual(expected ? ["Child"] : []);
}

it("a late usage record restores its captured active leaf instead of its own completed parent", async () => {
	const { root, subs } = fixture({ Child: cutOff });
	const sub = subs.Child!;
	const completed = { ...assistant("abandoned completion"), id: "completed", parentId: sub.entries[1]!.id };
	sub.entries.push(completed, {
		type: "model_usage",
		id: "late-usage",
		parentId: completed.id,
		activeLeafId: sub.leafId,
		timestamp: new Date().toISOString(),
		purpose: "advisor",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: createAssistantMessage("").usage,
		stopReason: "stop",
	});
	sub.leafId = resolveSessionLeafId(sub.entries);
	await verifyRestore(root, true);
});

it.each(["selected", "abandoned"] as const)("a normal exit only closes the %s ancestry", async selection => {
	const { root, subs } = fixture({ Child: cutOff });
	const sub = subs.Child!;
	const exit: SessionEntry = {
		type: "custom",
		id: "normal-exit",
		parentId: sub.leafId,
		timestamp: new Date().toISOString(),
		customType: "session_exit",
		data: { reason: "shutdown", kind: "normal", recordedAt: new Date().toISOString() },
	};
	sub.entries.push(exit);
	if (selection === "selected") {
		sub.leafId = exit.id;
		sub.entries.push({
			...assistant({ id: "abandoned", name: "read" }),
			id: "abandoned",
			parentId: sub.entries[1]!.id,
		});
	}
	await verifyRestore(root, selection === "abandoned");
});

it.each(["terminal", "incremental"] as const)("selected %s yield follows its own completion contract", async kind => {
	const incremental = kind === "incremental";
	const yieldCall = assistant({ id: "yield-call", name: "yield" });
	const yielded = entry({
		role: "toolResult",
		toolCallId: "yield-call",
		toolName: "yield",
		content: [],
		isError: false,
		timestamp: 1,
		details: incremental ? { status: "success", type: ["section"] } : { status: "success", data: "final" },
	});
	const { root, subs } = fixture({ Child: [user, yieldCall, yielded] });
	const sub = subs.Child!;
	const sibling = incremental ? assistant("abandoned completion") : assistant({ id: "abandoned", name: "read" });
	sub.entries.push({ ...sibling, id: "abandoned", parentId: sub.entries[1]!.id });
	await verifyRestore(root, incremental);
});

it("a selected interrupted-turn abort resumes even when an abandoned sibling completed", async () => {
	const aborted = createAssistantMessage("");
	aborted.stopReason = "aborted";
	aborted.errorMessage = INTERRUPTED_TURN_ERROR;
	const { root, subs } = fixture({ Child: [user, entry(aborted)] });
	subs.Child!.entries.push({
		...assistant("abandoned completion"),
		id: "completed",
		parentId: subs.Child!.entries[1]!.id,
	});
	await verifyRestore(root, true);
});
