import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Puppeteer from "puppeteer-core";
import type { Browser, CDPSession, Page, Target } from "puppeteer-core";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	forgetSharedTarget,
	forgetSharedTargets,
	recordSharedTarget,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as relayOwnedTargets from "@oh-my-pi/pi-coding-agent/tools/browser/relay/owned-targets";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";

const fixtures: Array<{ name: string; uploadDir: string; scope: SharedTargetScope }> = [];
afterEach(async () => {
	for (const { name, uploadDir, scope } of fixtures.splice(0)) {
		await releaseTab(name, { kill: false });
		await forgetSharedTargets(scope);
		await fs.rm(uploadDir, { recursive: true, force: true });
		await fs.rm(scope.projectDir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

async function ownedTargets(scope: SharedTargetScope): Promise<string[]> {
	// Join the real registry write chain after the supervisor's fire-and-forget forget.
	await recordSharedTarget(scope, "flush-probe");
	await forgetSharedTarget(scope, "flush-probe");
	const file = path.join(scope.runtimeDir!, `${scope.daemonName}.targets`, `${process.pid}.json`);
	if (!(await Bun.file(file).exists())) return [];
	const record = (await Bun.file(file).json()) as { targets: string[] };
	return record.targets;
}

/** Exercise the real inline WorkerCore producer, transport and supervisor consumer. */
async function fixture(options: { owned?: boolean; pageCloseFails?: boolean; fallbackCloses?: boolean } = {}) {
	const owned = options.owned ?? true;
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-close-"));
	const scope: SharedTargetScope = { projectDir: runtimeDir, runtimeDir, daemonName: "relay-fixture" };
	let pageClosed = false;
	let pageCloseCalls = 0;
	const targetId = `target-${crypto.randomUUID()}`;
	const session = {
		on: () => undefined,
		off: () => undefined,
		send: async () => ({}),
		detach: async () => undefined,
	} as unknown as CDPSession;
	const frame = { client: session, mainRealm: () => ({ evaluate: async () => undefined }) };
	const target = {
		_targetId: targetId,
		page: async () => page,
		createCDPSession: async () => session,
	} as unknown as Target;
	const page = {
		target: () => target,
		isClosed: () => pageClosed,
		close: async () => {
			pageCloseCalls++;
			if (options.pageCloseFails) throw new Error("fixture relay removeTab failed");
			pageClosed = true;
		},
		on: () => undefined,
		off: () => undefined,
		mainFrame: () => frame,
		frames: () => [],
		createCDPSession: async () => session,
		emulateFocusedPage: async () => undefined,
		evaluateOnNewDocument: async () => ({ identifier: "fixture-preload" }),
		removeScriptToEvaluateOnNewDocument: async () => undefined,
		evaluate: async () => "fixture-user-agent",
		url: () => "https://example.com/",
		title: async () => "close fixture",
		viewport: () => ({ width: 800, height: 600 }),
	} as unknown as Page;
	const browser = {
		connected: true,
		targets: () => [target],
		disconnect: () => undefined,
		wsEndpoint: () => "ws://127.0.0.1:9224/cdp",
	} as unknown as Browser;
	spyOn(launch, "loadPuppeteerInWorker").mockResolvedValue(Puppeteer);
	spyOn(launch, "connectPuppeteer").mockResolvedValue(browser);
	spyOn(launch, "loadedKnownDevices").mockReturnValue({});
	spyOn(launch, "loadedNetworkConditions").mockReturnValue({});
	spyOn(launch, "readPageViewport").mockResolvedValue({ width: 800, height: 600 });
	spyOn(attach, "resolveAttachTarget").mockResolvedValue({ page, ownsTarget: owned });
	spyOn(relayOwnedTargets, "relayTargetScope").mockReturnValue(scope);
	const fallback = spyOn(relayOwnedTargets, "closeRelayTarget").mockImplementation(async () => {
		if (options.fallbackCloses) pageClosed = true;
		return options.fallbackCloses ?? false;
	});
	// Select the production inline fallback; no test double produces a ready/closed packet.
	spyOn(globalThis, "Worker").mockImplementation((() => {
		throw new Error("select real inline WorkerCore for fault injection");
	}) as never);
	const handle = {
		key: `relay-close-${crypto.randomUUID()}`,
		kind: { kind: "relay", cdpUrl: "http://127.0.0.1:9224" },
		cdpUrl: "http://127.0.0.1:9224",
		refCount: 2,
		stealth: { browserSession: null, override: null },
		browser,
	} as unknown as PuppeteerBrowserHandle;
	const name = `close-${crypto.randomUUID()}`;
	const { tab } = await acquireTab(name, handle, { timeoutMs: 1_000, ownerSessionId: "close-owner" });
	if (tab.backend !== "worker") throw new Error("Expected production worker backend");
	fixtures.push({ name, uploadDir: tab.uploadDir, scope });
	expect(tab.worker.mode).toBe("inline");
	const messages: WorkerOutbound[] = [];
	tab.worker.onMessage(message => messages.push(message));
	return { name, scope, targetId, fallback, messages, isClosed: () => pageClosed, closeCalls: () => pageCloseCalls };
}

describe("real worker close confirmation and durable relay ownership", () => {
	it("keeps an owned target discoverable when both worker close and supervisor fallback fail", async () => {
		const state = await fixture({ pageCloseFails: true });
		expect(await ownedTargets(state.scope)).toContain(state.targetId);
		await releaseTab(state.name, { kill: false });
		expect(state.closeCalls()).toBe(1);
		expect(state.isClosed()).toBe(false);
		expect(state.messages.filter(message => message.type === "closed")).toHaveLength(1);
		expect(await ownedTargets(state.scope)).toContain(state.targetId);
		expect(state.fallback).toHaveBeenCalledTimes(1);
	});

	it("forgets ownership only after the failed worker close is confirmed by fallback", async () => {
		const state = await fixture({ pageCloseFails: true, fallbackCloses: true });
		await releaseTab(state.name, { kill: false });
		expect(state.closeCalls()).toBe(1);
		expect(state.isClosed()).toBe(true);
		expect(state.fallback).toHaveBeenCalledTimes(1);
		expect(state.fallback).toHaveBeenCalledWith("ws://127.0.0.1:9224/cdp", state.targetId);
		expect(await ownedTargets(state.scope)).not.toContain(state.targetId);
	});

	it("keeps a successful graceful owned close single-shot", async () => {
		const state = await fixture();
		await releaseTab(state.name, { kill: false });
		expect(state.closeCalls()).toBe(1);
		expect(state.isClosed()).toBe(true);
		expect(state.fallback).not.toHaveBeenCalled();
		expect(await ownedTargets(state.scope)).not.toContain(state.targetId);
	});

	it("never closes an adopted user tab through either path", async () => {
		const state = await fixture({ owned: false, pageCloseFails: true });
		await releaseTab(state.name, { kill: false });
		expect(state.closeCalls()).toBe(0);
		expect(state.isClosed()).toBe(false);
		expect(state.fallback).not.toHaveBeenCalled();
		expect(await ownedTargets(state.scope)).not.toContain(state.targetId);
	});

	it("bounds an unresponsive fallback and retains ownership after the real worker reports failure", async () => {
		const state = await fixture({ pageCloseFails: true });
		const gate = Promise.withResolvers<boolean>();
		state.fallback.mockImplementation(async () => gate.promise);
		try {
			await expect(releaseTab(state.name, { kill: false, timeoutMs: 10 })).rejects.toThrow("Timed out");
			expect(state.closeCalls()).toBe(1);
			expect(state.isClosed()).toBe(false);
			expect(state.fallback).toHaveBeenCalledTimes(1);
			expect(await ownedTargets(state.scope)).toContain(state.targetId);
		} finally {
			gate.resolve(false);
		}
	});
});
