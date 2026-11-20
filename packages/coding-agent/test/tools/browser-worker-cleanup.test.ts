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
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
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

it.each([false, true])("requires root-CDP confirmation before forgetting a headless page (confirmed=%s)", async confirmed => {
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
});
