/**
 * Stepped spawns: the executor sends each step prompt only after the previous
 * one was delivered (a terminal `yield`, or without `yield` the final message),
 * returns the last step's result, and records progress `omp --restore` reads.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { readStepProgress } from "@oh-my-pi/pi-coding-agent/task/steps";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
let tempDir: TempDir | undefined;
let restoreManager: AsyncJobManager | undefined;
const PROMPTS = ["STEP-ONE", "STEP-TWO", "STEP-THREE"];

function assistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface Child {
	yield(details: { status: "success"; data: unknown } | { status: "aborted"; error: string }): void;
	say(text: string): void;
}

/** A mock child that answers each prompt through `answer`, recording prompts and step entries. */
function stepSession(
	answer: (prompt: string, child: Child) => void,
	tools: string[],
	beforeInsert: (text: string) => void,
) {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const prompts: string[] = [];
	const entries: FileEntry[] = [];
	let calls = 0;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const child: Child = {
		yield: details => {
			calls += 1;
			const assistant = {
				...assistantStop(""),
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: `yield-${calls}`, name: "yield", arguments: details }],
			} as AssistantMessage;
			messages.push(assistant);
			entries.push({ type: "message", message: assistant } as FileEntry);
			entries.push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `yield-${calls}`,
					toolName: "yield",
					content: [{ type: "text", text: "Result submitted." }],
					details,
					isError: false,
					timestamp: Date.now(),
				},
			} as FileEntry);
			emit({
				type: "tool_execution_end",
				toolCallId: `yield-${calls}`,
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details },
			} as AgentSessionEvent);
		},
		say: text => {
			const message = assistantStop(text);
			messages.push(message);
			entries.push({ type: "message", message } as FileEntry);
			emit({ type: "message_end", message } as AgentSessionEvent);
		},
	};
	const session = {
		...createSessionDefaults(),
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
			getBranch: () => entries,
			appendCustomEntry: (customType: string, data: unknown) => {
				entries.push({ type: "custom", customType, data } as FileEntry);
			},
		},
		getActiveToolNames: () => tools,
		getEnabledToolNames: () => tools,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async (text: string) => {
			beforeInsert(text);
			prompts.push(text);
			entries.push({
				type: "message",
				message: { role: "user", content: text, timestamp: Date.now() },
			} as FileEntry);
			answer(text, child);
			return true;
		},
		getLastAssistantMessage: () => messages.at(-1),
		restoreInterruptedTurn: async (): Promise<boolean> =>
			AgentSession.prototype.restoreInterruptedTurn.call(session as unknown as AgentSession),
		setWorkPoolYieldItems: async () => {},
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
	};
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: session as unknown as AgentSession,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
	return { prompts, entries, session };
}

describe("step dispatch persistence window", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await restoreManager?.dispose({ timeoutMs: 1000 });
		restoreManager = undefined;
		AgentRegistry.global().unregister("step-window");
		tempDir?.removeSync();
		tempDir = undefined;
		AsyncJobManager.resetForTests();
	});
	it("does not dispatch an already inserted step again after its model turn throws", async () => {
		let failSecond = true;
		const harness = stepSession(
			(text, child) => {
				if (text === PROMPTS[1] && failSecond) throw new Error("injected model error after insertion");
				child.say(`done ${text}`);
			},
			["read"],
			() => {},
		);
		const first = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: PROMPTS[0],
			steps: PROMPTS,
			structured: false,
			index: 0,
			id: "step-window",
		});
		expect(first.exitCode).not.toBe(0);
		expect(harness.prompts).toEqual(PROMPTS.slice(0, 2));
		const progress = readStepProgress(harness.entries);
		expect(progress?.sent).toBe(2);
		failSecond = false;
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(
			harness.session as unknown as AgentSession,
		);
		await runSubagentFollowUpTurn({
			id: "step-window",
			agent,
			message: PROMPTS[0],
			restore: true,
			steps: progress,
			structured: false,
		});
		// This double tests dispatch identity, not interrupted provider-turn recovery.
		expect(harness.prompts).toEqual(PROMPTS);
	});

	it.each(["admission", "direct driver", "structured direct driver"] as const)(
		"preserves unfinished steps across insertion failure: %s",
		async mode => {
			let rejectSecond = true;
			const structured = mode === "structured direct driver";
			const harness = stepSession(
				(text, child) =>
					structured
						? child.yield({ status: "success", data: { report: `done ${text}` } })
						: child.say(`done ${text}`),
				structured ? ["read", "yield"] : ["read"],
				text => {
					if (text === PROMPTS[1] && rejectSecond) throw new Error("injected failure before prompt insertion");
				},
			);
			const first = await runSubprocess({
				cwd: "/tmp",
				agent,
				task: PROMPTS[0],
				steps: PROMPTS,
				structured,
				index: 0,
				id: "step-window",
			});
			expect(first.exitCode).not.toBe(0);
			expect(harness.prompts).toEqual([PROMPTS[0]]);
			const progress = readStepProgress(harness.entries);
			if (mode === "admission") {
				// This case checks only admission; a separate case drives the executor.
				tempDir = TempDir.createSync("step-dispatch-window-");
				const cwd = tempDir.path();
				const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
				main.appendMessage({ role: "user", content: "run steps", timestamp: Date.now() });
				const mainFile = main.getSessionFile();
				if (!mainFile) throw new Error("Expected persisted main file");
				await main.ensureOnDisk();
				await main.close();
				expect(await Bun.file(mainFile).exists()).toBe(true);
				const childFile = path.join(mainFile.slice(0, -6), "step-window.jsonl");
				const persisted = await SessionManager.open(childFile, undefined, undefined, {
					initialCwd: cwd,
					parentSession: mainFile,
					suppressBreadcrumb: true,
				});
				persisted.appendSessionInit({ systemPrompt: ["test"], task: PROMPTS[0], tools: ["read"] });
				for (const entry of harness.entries) {
					if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))
						persisted.appendMessage(entry.message);
					else if (entry.type === "custom") persisted.appendCustomEntry(entry.customType, entry.data);
				}
				await persisted.close();
				expect((await collectSubSessions(mainFile))["step-window"]?.agentId).toBe("step-window");
				restoreManager = new AsyncJobManager({});
				const parent = {
					sessionManager: { getSessionFile: () => mainFile },
					asyncJobManager: restoreManager,
					settings: Settings.isolated(),
					yieldQueue: { holdIdleFlush: () => () => {} },
					waitForIdle: async () => {},
					restoreInterruptedTurn: async () => false,
				} as unknown as AgentSession;
				vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue({ ...first, exitCode: 0 });
				const admission = await restoreSession(parent);
				await restoreManager.getJob("step-window")?.promise;
				console.log(JSON.stringify({ phase: "restore-admission", admission, beforeRestore: progress }));
				expect(admission.subagents).toEqual(["step-window"]);
				return;
			}
			rejectSecond = false;
			vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(
				harness.session as unknown as AgentSession,
			);
			const restored = await runSubagentFollowUpTurn({
				id: "step-window",
				agent,
				message: PROMPTS[0],
				restore: true,
				steps: progress,
				structured,
			});
			console.log(
				JSON.stringify({
					phase: "executor-window",
					beforeRestore: progress,
					inserted: harness.prompts,
					restoredExit: restored.exitCode,
					restoredOutput: restored.output,
				}),
			);
			expect(harness.prompts).toEqual(PROMPTS);
			expect(restored.exitCode).toBe(0);
			expect(readStepProgress(harness.entries)?.sent).toBe(PROMPTS.length);
		},
	);
});
