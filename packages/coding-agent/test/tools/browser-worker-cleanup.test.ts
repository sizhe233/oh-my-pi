import { afterEach, beforeEach, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import * as relayOwnedTargets from "@oh-my-pi/pi-coding-agent/tools/browser/relay/owned-targets";
import { RELAY_RETRY_FOREIGN_FRAME_QUERY } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	releaseTab,
	runInTab,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import * as piUtils from "@oh-my-pi/pi-utils";

const NAME = "cleanup-fixture";
const TARGET = "PAGEfixture.7";
const RELAY_HTTP = "http://127.0.0.1:9224";
const RELAY_WS = "ws://127.0.0.1:9224/cdp";

let tmp: string;
let scope: SharedTargetScope;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-cleanup-"));
	scope = { projectDir: tmp, runtimeDir: tmp, daemonName: "omp.browser.headless" };
	spyOn(piUtils, "getDaemonRuntimeDir").mockReturnValue(tmp);
	spyOn(relayOwnedTargets, "relayTargetScope").mockReturnValue(scope);
});

afterEach(async () => {
	getTabsMapForTest().delete(NAME);
	resetOrphanRegistryForTest();
	vi.restoreAllMocks();
	await fs.rm(tmp, { recursive: true, force: true });
});

async function ownershipOnDisk(): Promise<string[]> {
	// Join earlier fire-and-forget receipt writes before inspecting the real file.
	const barrier = "fixture-barrier";
	await recordSharedTarget(scope, barrier);
	await forgetSharedTarget(scope, barrier);
	const receipt = Bun.file(path.join(tmp, scope.daemonName + ".targets", process.pid + ".json"));
	if (!(await receipt.exists())) return [];
	return (await receipt.json()).targets;
}

function publishTab(opts: {
	relay: boolean;
	ownsPage: boolean;
	acknowledge?: boolean;
	recovered?: boolean;
	rootConnection?: object;
}): WorkerTabSession {
	const browser = {
		connected: true,
		_connection: opts.rootConnection,
	};
	const tab: WorkerTabSession = {
		name: NAME,
		browser: {
			browser: browser as unknown as WorkerTabSession["browser"]["browser"],
			key: NAME,
			kind: opts.relay ? { kind: "relay", cdpUrl: RELAY_HTTP } : { kind: "headless", headless: true },
			refCount: 2,
			wsEndpoint: RELAY_WS,
			cdpUrl: opts.relay ? RELAY_HTTP : undefined,
			sharedDaemon: opts.relay ? undefined : { projectDir: tmp, name: scope.daemonName },
			stealth: { browserSession: null, override: null },
		},
		targetId: TARGET,
		backend: "worker",
		state: "alive",
		info: { url: "about:blank", targetId: TARGET, viewport: { width: 800, height: 600 } },
		pending: new Map(),
		kindTag: opts.relay ? "relay" : "headless",
		ownerSessionId: "synthetic-owner",
		lastActivityAt: Date.now(),
		frozen: false,
		ownsPage: opts.ownsPage,
		uploadDir: path.join(tmp, "uploads"),
		workerExitedAt: opts.recovered ? Date.now() : undefined,
		worker: {
			mode: "worker",
			send: vi.fn(),
			onMessage: handler => {
				if (opts.acknowledge) queueMicrotask(() => handler({ type: "closed" }));
				return () => {};
			},
			onError: () => () => {},
			onExit: () => () => {},
			terminate: vi.fn(async () => {}),
		},
	};
	getTabsMapForTest().set(NAME, tab);
	return tab;
}

it.each([false, true])("checks an owned relay page after a recovered worker ACK (confirmed=%s)", async confirmed => {
	const close = spyOn(relayOwnedTargets, "closeRelayOwnedTarget").mockResolvedValue(confirmed);
	const health = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(true);
	await recordSharedTarget(scope, TARGET);
	const tab = publishTab({ relay: true, ownsPage: true, acknowledge: true, recovered: true });

	expect(await releaseTab(NAME, { timeoutMs: 100 })).toBe(true);
	expect(tab.worker.send).toHaveBeenCalledWith({ type: "close", keepPage: undefined });
	expect(tab.worker.terminate).toHaveBeenCalledTimes(1);
	expect(close).toHaveBeenCalledTimes(1);
	expect(close).toHaveBeenCalledWith(RELAY_WS, TARGET);
	expect(await ownershipOnDisk()).toEqual(confirmed ? [] : [TARGET]);
	expect(health).not.toHaveBeenCalled();
	expect(getTabsMapForTest().has(NAME)).toBe(false);
});

it("lets an owned relay's close retries finish before terminating its worker", async () => {
	const order: string[] = [];
	spyOn(relayOwnedTargets, "closeRelayOwnedTarget").mockImplementation(async () => {
		order.push("confirm");
		return true;
	});
	await recordSharedTarget(scope, TARGET);
	const tab = publishTab({ relay: true, ownsPage: true });
	tab.worker.onMessage = handler => {
		const timer = setTimeout(() => {
			order.push("worker-ack");
			handler({ type: "closed" });
		}, 1_000); // Two transient removeTab refusals, 500ms apart.
		return () => clearTimeout(timer);
	};
	tab.worker.terminate = async () => {
		order.push("terminate");
	};

	expect(await releaseTab(NAME, { timeoutMs: 2_000 })).toBe(true);
	expect(order).toEqual(["worker-ack", "terminate", "confirm"]);
	expect(await ownershipOnDisk()).toEqual([]);
});

it.each([
	{ mode: "owned", ownsPage: true },
	{ mode: "borrowed", ownsPage: false },
])("force-kills a $mode relay worker without stopping Chrome", async ({ ownsPage }) => {
	const close = spyOn(relayOwnedTargets, "closeRelayOwnedTarget").mockResolvedValue(false);
	const health = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(true);
	if (ownsPage) await recordSharedTarget(scope, TARGET);
	const tab = publishTab({ relay: true, ownsPage });
	const session = {
		cwd: tmp,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;

	await expect(runInTab(NAME, { code: "await wait(60_000);", timeoutMs: 20, session })).rejects.toThrow("hung past");
	expect(tab.worker.terminate).toHaveBeenCalledTimes(1);
	expect(close).toHaveBeenCalledTimes(ownsPage ? 1 : 0);
	if (ownsPage) expect(close).toHaveBeenCalledWith(RELAY_WS, TARGET);
	expect(health).not.toHaveBeenCalled();
	expect(await ownershipOnDisk()).toEqual(ownsPage ? [TARGET] : []);
	expect(getTabsMapForTest().has(NAME)).toBe(false);
});

it.each([false, true])(
	"requires root-CDP confirmation before forgetting a headless page (confirmed=%s)",
	async confirmed => {
		const health = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		const send = vi.fn(async (method: string) => {
			if (method === "Target.closeTarget") return { success: false };
			if (method === "Target.getTargets") return { targetInfos: confirmed ? [] : [{ targetId: TARGET }] };
			throw new Error("Unexpected CDP method: " + method);
		});
		const rootConnection = { send, createSession() {}, on() {}, off() {} };
		await recordSharedTarget(scope, TARGET);
		publishTab({ relay: false, ownsPage: true, acknowledge: true, recovered: true, rootConnection });

		expect(await releaseTab(NAME, { timeoutMs: 100 })).toBe(true);
		expect(send).toHaveBeenNthCalledWith(1, "Target.closeTarget", { targetId: TARGET });
		expect(send).toHaveBeenNthCalledWith(2, "Target.getTargets");
		expect(send).toHaveBeenCalledTimes(2);
		expect(await ownershipOnDisk()).toEqual(confirmed ? [] : [TARGET]);
		expect(health).toHaveBeenCalledTimes(confirmed ? 0 : 1);
		expect(getTabsMapForTest().has(NAME)).toBe(false);
	},
);

const TEST_FOREIGN_REFUSAL = "Cannot access a chrome-extension:// URL of different extension";

function heldOutFixture(
	ownsPage: boolean,
	refusalTarget = TARGET,
	beforeReply?: () => Promise<void>,
): { tab: WorkerTabSession; session: ToolSession } {
	const tab = publishTab({
		relay: true,
		ownsPage,
		rootConnection: {
			createSession() {},
			async send(method: string, params: { targetId?: string }) {
				expect(method).toBe("Target.getTargetInfo");
				expect(params.targetId).toBe(TARGET);
				await beforeReply?.();
				return { targetInfo: { targetId: refusalTarget }, refusal: TEST_FOREIGN_REFUSAL };
			},
		},
	});
	tab.heldOut = true;
	return {
		tab,
		session: {
			cwd: tmp,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession,
	};
}

function mockHeldOutWorkers(
	tab: WorkerTabSession,
	refuse = false,
	lifecycle?: { spawned(): void; terminated(): void; beforeConnect?(): Promise<void>; connected?(): void },
): WorkerInitPayload[] {
	const starts: WorkerInitPayload[] = [];
	class BrowserWorker extends EventTarget {
		#terminated = false;

		postMessage(msg: WorkerInbound): void {
			const emit = (data: WorkerOutbound) => this.dispatchEvent(new MessageEvent("message", { data }));
			if (msg.type === "init") {
				starts.push(msg.payload);
				const connect = () => {
					if (this.#terminated) return;
					lifecycle?.connected?.();
					emit({ type: "setup" });
					if (refuse) {
						emit({
							type: "init-failed",
							error: { name: "ToolError", message: TEST_FOREIGN_REFUSAL, isToolError: true, isAbort: false },
						});
					} else {
						emit({ type: "ready", info: tab.info });
					}
				};
				if (lifecycle?.beforeConnect) void lifecycle.beforeConnect().then(connect);
				else queueMicrotask(connect);
			} else if (msg.type === "close") {
				queueMicrotask(() => emit({ type: "closed" }));
			} else if (msg.type === "run") {
				queueMicrotask(() =>
					emit({
						type: "result",
						id: msg.id,
						ok: true,
						payload: { returnValue: "same document", displays: [], screenshots: [] },
					}),
				);
			}
		}

		terminate(): void {
			this.#terminated = true;
			lifecycle?.terminated();
		}
	}
	spyOn(globalThis, "Worker").mockImplementation((() => {
		const worker = new BrowserWorker();
		lifecycle?.spawned();
		return worker;
	}) as never);
	return starts;
}

it.each([
	{ refusalTarget: TARGET, expectedRetry: "1" },
	{ refusalTarget: "relay-browser", expectedRetry: null },
	{ refusalTarget: "PAGEanother.7", expectedRetry: null },
])("opts in only for the exact cached refusal ($refusalTarget)", async ({ refusalTarget, expectedRetry }) => {
	const { tab, session } = heldOutFixture(false, refusalTarget);
	const starts = mockHeldOutWorkers(tab);
	const result = await runInTab(NAME, { code: "return await tab.title()", timeoutMs: 5_000, session });
	expect(result.returnValue).toBe("same document");
	expect(starts).toHaveLength(1);
	const payload = starts[0];
	if (payload?.mode !== "attach") throw new Error("Expected a worker adopting the same target");
	const endpoint = new URL(payload.browserWSEndpoint);
	expect(endpoint.searchParams.get("claim")).toBe(TARGET);
	expect(endpoint.searchParams.get(RELAY_RETRY_FOREIGN_FRAME_QUERY)).toBe(expectedRetry);
	expect(payload.page).toEqual({ kind: "borrowed", targetId: TARGET });
	expect(payload.recover).toBeFalse();
	expect(getTabsMapForTest().get(NAME)).toBe(tab);
	expect(tab.heldOut).toBeUndefined();
});

it("keeps an explicit native refusal and does not try an inline fallback", async () => {
	const { tab, session } = heldOutFixture(false);
	const starts = mockHeldOutWorkers(tab, true);
	const invoke = () => runInTab(NAME, { code: "return await tab.title()", timeoutMs: 5_000, session });
	const calls = await Promise.allSettled([invoke(), invoke()]);
	expect(
		calls.every(call => call.status === "rejected" && String(call.reason).includes("left the frame unchanged")),
	).toBeTrue();
	expect(starts).toHaveLength(1);
	expect(tab.heldOut).toBeTrue();
	expect(getTabsMapForTest().get(NAME)).toBe(tab);
});

it("does not opt in for an owned or already-aborted held-out tab", async () => {
	const owned = heldOutFixture(true);
	const starts = mockHeldOutWorkers(owned.tab);
	await expect(runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session: owned.session })).rejects.toThrow(
		"Chrome still keeps omp out",
	);
	const borrowed = heldOutFixture(false);
	await expect(
		runInTab(NAME, {
			code: "return 1",
			timeoutMs: 5_000,
			session: borrowed.session,
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow();
	expect(starts).toHaveLength(0);
	expect(borrowed.tab.heldOut).toBeTrue();
});

it("does not spawn or claim after release during old-worker termination", async () => {
	const { tab, session } = heldOutFixture(false);
	const terminating = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const oldTerminate = spyOn(tab.worker, "terminate").mockImplementationOnce(async () => {
		terminating.resolve();
		await resume.promise;
	});
	const spawned = vi.fn();
	const terminated = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, { spawned, terminated });
	const run = runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session }).catch((error: unknown) => error);
	try {
		await terminating.promise;
		expect(await releaseTab(NAME)).toBeTrue();
		const replacement = heldOutFixture(false).tab;
		resume.resolve();
		expect(String(await run)).toContain("was closed while its worker was being reattached");
		expect(getTabsMapForTest().get(NAME)).toBe(replacement);
		expect(replacement.worker.terminate).not.toHaveBeenCalled();
		expect(oldTerminate).toHaveBeenCalledTimes(2);
		expect(spawned).not.toHaveBeenCalled();
		expect(terminated).not.toHaveBeenCalled();
		expect(starts).toEqual([]);
	} finally {
		resume.resolve();
		await run;
	}
});

it("terminates only the nascent worker without init when release starts during spawn", async () => {
	const { tab, session } = heldOutFixture(false);
	const releasing = Promise.withResolvers<void>();
	const finishRelease = Promise.withResolvers<void>();
	const oldTerminate = spyOn(tab.worker, "terminate")
		.mockResolvedValueOnce(undefined)
		.mockImplementationOnce(async () => {
			releasing.resolve();
			await finishRelease.promise;
		});
	let close: Promise<boolean> | undefined;
	const spawned = vi.fn(() => {
		close = releaseTab(NAME);
	});
	const terminated = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, { spawned, terminated });
	const run = runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session }).catch((error: unknown) => error);
	try {
		await releasing.promise;
		expect(await run).toBeInstanceOf(Error);
		expect(tab.state).toBe("dead");
		expect(getTabsMapForTest().get(NAME)).toBe(tab);
		expect(oldTerminate).toHaveBeenCalledTimes(2);
		expect(spawned).toHaveBeenCalledTimes(1);
		expect(terminated).toHaveBeenCalledTimes(1);
		expect(starts).toEqual([]);
	} finally {
		finishRelease.resolve();
		if (close) expect(await close).toBeTrue();
		await run;
	}
});

it("does not spend an explicit borrowed retry when the cache read outlasts its operation", async () => {
	const resume = Promise.withResolvers<void>();
	const { tab, session } = heldOutFixture(false, TARGET, () => resume.promise);
	const spawned = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, { spawned, terminated: vi.fn() });
	const run = runInTab(NAME, { code: "return 1", timeoutMs: 25, session }).catch((error: unknown) => error);
	const recovery = tab.workerRecovery?.catch((error: unknown) => error);
	expect(recovery).toBeDefined();
	try {
		expect(await run).toBeInstanceOf(Error);
	} finally {
		resume.resolve();
		await recovery;
	}
	expect(tab.worker.terminate).not.toHaveBeenCalled();
	expect(spawned).not.toHaveBeenCalled();
	expect(starts).toEqual([]);
	expect(getTabsMapForTest().get(NAME)).toBe(tab);
	expect(tab.heldOut).toBeTrue();
});

it("does not spend an explicit borrowed retry when worker termination outlasts the call", async () => {
	const { tab, session } = heldOutFixture(false);
	const terminating = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	spyOn(tab.worker, "terminate").mockImplementationOnce(async () => {
		terminating.resolve();
		await resume.promise;
	});
	const spawned = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, { spawned, terminated: vi.fn() });
	const run = runInTab(NAME, { code: "return 1", timeoutMs: 50, session }).catch((error: unknown) => error);
	const recovery = tab.workerRecovery?.catch((error: unknown) => error);
	expect(recovery).toBeDefined();
	try {
		await terminating.promise;
		expect(String(await run)).toContain("was still being reattached");
	} finally {
		resume.resolve();
	}
	expect(String(await recovery)).toContain("Timed out rechecking Chrome");
	expect(spawned).not.toHaveBeenCalled();
	expect(starts).toEqual([]);
	expect(getTabsMapForTest().get(NAME)).toBe(tab);
	expect(tab.heldOut).toBeTrue();
});

it("does not initialize a nascent borrowed retry after its operation deadline", async () => {
	const { tab, session } = heldOutFixture(false);
	let now = performance.now();
	spyOn(performance, "now").mockImplementation(() => now);
	const spawned = vi.fn(() => {
		now += 6_000;
	});
	const terminated = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, { spawned, terminated });
	await expect(runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session })).rejects.toThrow(
		"Timed out rechecking Chrome",
	);
	expect(spawned).toHaveBeenCalledTimes(1);
	expect(terminated).toHaveBeenCalledTimes(1);
	expect(starts).toEqual([]);
	expect(getTabsMapForTest().get(NAME)).toBe(tab);
	expect(tab.heldOut).toBeTrue();
});

it("stops an opted-in worker after init but before connect when the borrowed binding is released", async () => {
	const { tab, session } = heldOutFixture(false);
	const initializing = Promise.withResolvers<void>();
	const allowConnect = Promise.withResolvers<void>();
	const spawned = vi.fn();
	const terminated = vi.fn();
	const connected = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, {
		spawned,
		terminated,
		connected,
		beforeConnect() {
			initializing.resolve();
			return allowConnect.promise;
		},
	});
	const run = runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session }).catch((error: unknown) => error);
	try {
		await initializing.promise;
		expect(spawned).toHaveBeenCalledTimes(1);
		expect(starts).toHaveLength(1);
		expect(new URL(starts[0]!.browserWSEndpoint).searchParams.get(RELAY_RETRY_FOREIGN_FRAME_QUERY)).toBe("1");
		expect(await releaseTab(NAME)).toBeTrue();
		const replacement = heldOutFixture(false).tab;
		allowConnect.resolve();
		expect(await run).toBeInstanceOf(Error);
		expect(connected).not.toHaveBeenCalled();
		expect(terminated).toHaveBeenCalledTimes(1);
		expect(getTabsMapForTest().get(NAME)).toBe(replacement);
		expect(replacement.worker.terminate).not.toHaveBeenCalled();
	} finally {
		allowConnect.resolve();
		await run;
	}
});

it("transfers the opted-in worker out of pending cancellation before publishing", async () => {
	const { tab, session } = heldOutFixture(false);
	const terminated = vi.fn();
	const starts = mockHeldOutWorkers(tab, false, { spawned: vi.fn(), terminated });
	expect((await runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session })).returnValue).toBe("same document");
	expect(starts).toHaveLength(1);
	expect(await releaseTab(NAME)).toBeTrue();
	expect(terminated).toHaveBeenCalledTimes(1);
});

it("does not connect inline when a terminable isolated worker cannot start", async () => {
	const { tab, session } = heldOutFixture(false);
	const spawn = spyOn(globalThis, "Worker").mockImplementation((() => {
		throw new Error("isolated worker intentionally unavailable");
	}) as never);
	await expect(runInTab(NAME, { code: "return 1", timeoutMs: 5_000, session })).rejects.toThrow(
		"Could not start an isolated worker to recheck Chrome's access",
	);
	expect(spawn).toHaveBeenCalledTimes(1);
	expect(tab.heldOut).toBeTrue();
	expect(getTabsMapForTest().get(NAME)).toBe(tab);
});
