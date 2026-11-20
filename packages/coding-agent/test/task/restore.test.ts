import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

/** A turn the process died in, mid tool call (no result, no exit record). */
const cutOff: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		stopReason: "toolUse",
	}),
];
/** A turn that ended on the model's own answer. */
const finished: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ content: [{ type: "text", text: "all done" }] }),
];

/** Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract. */
async function writeSubagent(
	mainFile: string,
	cwd: string,
	id: string,
	messages: Message[],
	agent?: string,
): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"], agent });
	for (const message of messages) manager.appendMessage(message);
	await manager.close();
	return file;
}

describe("restoreSession (omp --restore)", () => {
	const ids = ["Cut", "Done", "Killed"];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones", async () => {
		tempDir = TempDir.createSync("@pi-restore-subagents-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await main.close();
		const cutFile = await writeSubagent(mainFile, cwd, "Cut", cutOff, "scout");
		await writeSubagent(mainFile, cwd, "Done", finished);
		const killed = await writeSubagent(mainFile, cwd, "Killed", cutOff);
		await fs.writeFile(getAgentTombstonePath(killed), "");

		manager = new AsyncJobManager({});
		const delivered: string[] = [];
		const idleReleaseRequested = Promise.withResolvers<void>();
		const allowIdleRelease = Promise.withResolvers<void>();
		const idleReleased = Promise.withResolvers<void>();
		const allowDelivery = Promise.withResolvers<void>();
		manager.registerDeliverySink(MAIN_AGENT_ID, async jobId => {
			await idleReleased.promise;
			await allowDelivery.promise;
			delivered.push(jobId);
		});
		const result: SingleResult = {
			index: 0,
			id: "Cut",
			agent: "Cut",
			agentSource: "user",
			task: "Cut task",
			exitCode: 0,
			output: "finished after the restart",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		const registry = AgentRegistry.global();
		const home = { instanceKey: "main:restore-unit-child", sessionFile: cutFile } as AgentSession;
		const ensureLive = vi
			.spyOn(AgentLifecycleManager.global(), "ensureLive")
			.mockImplementation(async (id, expected) => {
				const ref = registry.get(id);
				expect(id).toBe("Cut");
				expect(expected).toBe(ref);
				if (!ref || !registry.attachSession(id, home, cutFile, ref)) throw new Error("Cut home attach rejected");
				return home;
			});
		let listener: AgentSessionEventListener | undefined;
		const receiptId = "main:restore-unit:receipt";
		const drainStarted = Promise.withResolvers<void>();
		const drainDeliveries = manager.drainDeliveries.bind(manager);
		const drainReceipt = vi.spyOn(manager, "drainDeliveries").mockImplementation(options => {
			drainStarted.resolve();
			return drainDeliveries(options);
		});
		const releaseReceipt = vi
			.fn(async (token: string) => token === receiptId)
			.mockImplementationOnce(async token => {
				if (token !== receiptId) return false;
				idleReleaseRequested.resolve();
				await allowIdleRelease.promise;
				idleReleased.resolve();
				return true;
			});
		const receiptFinished = Promise.withResolvers<void>();
		const initialRunEnded = Promise.withResolvers<void>();
		const wakeRunEnded = Promise.withResolvers<void>();
		const wakeWaitStarted = Promise.withResolvers<{ delivered: string[]; pending: boolean }>();
		const runEnded = vi
			.fn(() => {
				wakeWaitStarted.resolve({
					delivered: [...delivered],
					pending: manager!.hasPendingDeliveries({ ownerId: MAIN_AGENT_ID, restoreReceiptId: receiptId }),
				});
				return wakeRunEnded.promise;
			})
			.mockImplementationOnce(() => initialRunEnded.promise);
		const finishReceipt = vi.fn(async (token: string, discard: boolean) => {
			expect(token).toBe(receiptId);
			expect(discard).toBe(false);
			receiptFinished.resolve();
			return true;
		});
		const restoreTurn = vi.fn(async () => {
			// The final boundary can arrive before scheduling is acknowledged.
			listener?.({ type: "agent_end", messages: [] });
			expect(releaseReceipt).not.toHaveBeenCalled();
			return true;
		});
		const session = {
			instanceKey: "main:restore-unit",
			sessionFile: mainFile,
			getAgentId: () => MAIN_AGENT_ID,
			addDisposer: () => {},
			subscribe: (callback: AgentSessionEventListener) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			sessionManager: { getSessionFile: () => mainFile },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			acquireRestoreIdleHold: async (file: string, jobs: AsyncJobManager, signal: AbortSignal) => {
				expect(file).toBe(mainFile);
				expect(jobs === manager).toBe(true);
				signal.throwIfAborted();
				return receiptId;
			},
			releaseRestoreIdleHold: releaseReceipt,
			finishRestoreIdleHold: finishReceipt,
			waitForRunEnd: runEnded,
			restoreInterruptedTurn: restoreTurn,
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: true, subagents: ["Cut"] });
		// Restore publishes queued jobs before their runners necessarily start.
		await manager.getJob("Cut")!.promise;
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(ensureLive).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({
			id: "Cut",
			agent: { name: "Cut" },
			restore: true,
			message: "Cut task",
			softRequestBudget: 100,
		});
		// The pre-ack event must release the idle hold even though the
		// abandonment check's run-end promise has not resolved yet.
		await idleReleaseRequested.promise;
		expect(releaseReceipt).toHaveBeenCalledTimes(1);
		expect(releaseReceipt).toHaveBeenCalledWith(receiptId);
		expect(runEnded).toHaveBeenCalledTimes(1);
		expect(finishReceipt).not.toHaveBeenCalled();
		expect(delivered).toEqual([]);
		allowIdleRelease.resolve();
		initialRunEnded.resolve();

		// Deliver only after the real, receipt-scoped drain starts. The
		// subsequent wait must observe a drained queue and block finalization.
		const firstAfterRelease = await Promise.race([
			drainStarted.promise.then(() => "drain"),
			wakeWaitStarted.promise.then(() => "wake"),
		]);
		expect(firstAfterRelease).toBe("drain");
		expect(drainReceipt).toHaveBeenCalledWith({ filter: { ownerId: MAIN_AGENT_ID, restoreReceiptId: receiptId } });
		expect(runEnded).toHaveBeenCalledTimes(1);
		expect(delivered).toEqual([]);
		allowDelivery.resolve();
		expect(await wakeWaitStarted.promise).toEqual({ delivered: ["Cut"], pending: false });
		expect(runEnded).toHaveBeenCalledTimes(2);
		expect(finishReceipt).not.toHaveBeenCalled();
		wakeRunEnded.resolve();
		await receiptFinished.promise;

		expect(delivered).toEqual(["Cut"]);
		expect(restoreTurn).toHaveBeenCalledTimes(1);
		expect(finishReceipt).toHaveBeenCalledTimes(1);
		expect(listener).toBeUndefined();
	});
});
