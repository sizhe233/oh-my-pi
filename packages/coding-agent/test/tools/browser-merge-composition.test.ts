import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { DownloadManager } from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import * as orphanRegistry from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as relayOwnedTargets from "@oh-my-pi/pi-coding-agent/tools/browser/relay/owned-targets";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { acquireTab, getTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserPrelude from "../../src/tools/browser/prelude.js" with { type: "text" };

/** Protocol fixture: consumes recovery state, retained file bytes and the real download manager. */
class ProtocolWorker extends EventTarget {
	payload?: WorkerInitPayload;
	failure?: "detached" | "cleanup" | "exit";
	terminated = false;
	runs = 0;
	downloadBehaviors: unknown[] = [];

	constructor(readonly page: { loading: boolean; focused: boolean; group?: string }) {
		super();
	}

	postMessage(message: WorkerInbound): void {
		queueMicrotask(() => void this.handle(message));
	}

	async handle(message: WorkerInbound): Promise<void> {
		if (message.type === "init") {
			this.payload = message.payload;
			if (message.payload.mode === "attach") {
				if (message.payload.recover) this.page.loading = false;
				this.page.focused = message.payload.emulateFocus === true;
				this.page.group = message.payload.groupLabel;
			}
			const downloads = new DownloadManager(
				{
					target: () => ({
						createCDPSession: async () => ({
							on: () => undefined,
							off: () => undefined,
							detach: async () => undefined,
							send: async (_method: string, params: unknown) => this.downloadBehaviors.push(params),
						}),
					}),
				} as unknown as Browser,
				{ frames: () => [], browserContext: () => ({}) } as unknown as Page,
				"composition-target",
				{ perTab: message.payload.mode === "headless" || message.payload.userDriven !== true },
			);
			await downloads.enable(path.join(message.payload.uploadDir, "downloads"));
			await downloads.close();
			this.emit({ type: "setup" });
			this.emit({
				type: "ready",
				info: {
					url: "https://example.com/",
					targetId: "composition-target",
					viewport: { width: 800, height: 600 },
				},
			});
		} else if (message.type === "close") {
			this.emit({ type: "closed" });
		} else if (message.type === "run") {
			this.runs++;
			if (this.failure === "exit") {
				this.failure = undefined;
				this.crash();
				return;
			}
			if (this.failure === "detached") {
				this.failure = undefined;
				this.emit({
					type: "result",
					id: message.id,
					ok: false,
					error: {
						name: "ToolError",
						message: "Chrome detached omp from this tab during this call",
						isToolError: true,
						isAbort: false,
						debuggerDetached: { when: "during", reason: "target_closed" },
					},
				});
				return;
			}
			const recoverTab = this.failure === "cleanup";
			this.failure = undefined;
			const contents = await Bun.file(path.join(this.payload!.uploadDir, "pick.txt")).text();
			this.emit({
				type: "result",
				id: message.id,
				ok: true,
				payload: {
					returnValue: { contents, ...this.page },
					displays: [],
					screenshots: [],
					recoverTab,
				},
			});
		}
	}

	emit(message: WorkerOutbound): void {
		this.dispatchEvent(new MessageEvent("message", { data: message }));
	}
	crash(): void {
		this.dispatchEvent(new CloseEvent("close", { code: 3 }));
	}
	terminate(): void {
		this.terminated = true;
	}
}

const opened: Array<{ name: string; uploadDir: string }> = [];
afterEach(async () => {
	for (const { name, uploadDir } of opened.splice(0)) {
		await releaseTab(name, { kill: false });
		await fs.rm(uploadDir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

async function fixture() {
	const workers: ProtocolWorker[] = [];
	const page = { loading: true, focused: false };
	spyOn(globalThis, "Worker").mockImplementation((() => {
		const worker = new ProtocolWorker(page);
		workers.push(worker);
		return worker;
	}) as never);
	const browser = {
		key: `composition-${crypto.randomUUID()}`,
		kind: { kind: "headless", headless: true },
		refCount: 2,
		stealth: { browserSession: null, override: null },
		browser: {
			wsEndpoint: () => "ws://127.0.0.1:9224/cdp",
			targets: () => [],
			target: () => ({
				createCDPSession: async () => ({ send: async () => ({ targetInfos: [] }), detach: async () => undefined }),
			}),
		},
	} as unknown as PuppeteerBrowserHandle;
	const name = `composition-${crypto.randomUUID()}`;
	const { tab } = await acquireTab(name, browser, { timeoutMs: 1_000, ownerSessionId: "composition-owner" });
	if (tab.backend !== "worker") throw new Error("Expected worker tab");
	opened.push({ name, uploadDir: tab.uploadDir });
	const file = path.join(tab.uploadDir, "pick.txt");
	await Bun.write(file, "retained upload bytes");
	const session = {
		cwd: tab.uploadDir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
	return {
		workers,
		tab,
		browser,
		file,
		session,
		run: () => runInTab(name, { code: "read picked file", timeoutMs: 1_000, session }),
	};
}

describe("browser merge ownership and recovery composition", () => {
	it.each([false, true])(
		"retains uploads/navigation and ownership-specific focus after relay debugger detach (owned=%s)",
		async ownsTarget => {
			const { workers, tab, browser, file, run } = await fixture();
			tab.kindTag = "relay";
			tab.ownsTarget = ownsTarget;
			browser.kind = { kind: "relay", cdpUrl: "http://127.0.0.1:9224" };
			workers[0]!.failure = "detached";
			await expect(run()).rejects.toThrow("reattached to the same tab on a new worker without reloading");
			expect((await run()).returnValue).toEqual({
				contents: "retained upload bytes",
				loading: true,
				focused: ownsTarget,
				group: ownsTarget ? "composition-owner" : undefined,
			});
			await releaseTab(tab.name, { kill: false });
			expect(await Bun.file(file).text()).toBe("retained upload bytes");
		},
	);

	it("still stops loading for ordinary cleanup recovery while retaining upload bytes", async () => {
		const { workers, tab, browser, run } = await fixture();
		tab.kindTag = "relay";
		browser.kind = { kind: "relay", cdpUrl: "http://127.0.0.1:9224" };
		workers[0]!.failure = "cleanup";
		await run();
		expect(workers[0]!.terminated).toBe(true);
		expect((await run()).returnValue).toMatchObject({ contents: "retained upload bytes", loading: false });
	});

	it("removes headless staged uploads when its page closes", async () => {
		const { tab, file } = await fixture();
		expect(await Bun.file(file).text()).toBe("retained upload bytes");
		await releaseTab(tab.name, { kill: false });
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it.each([false, true])("restores idle relay policy and reports its reset only once (owned=%s)", async ownsTarget => {
		const { workers, tab, browser, file, run } = await fixture();
		tab.kindTag = "relay";
		tab.ownsTarget = ownsTarget;
		browser.kind = { kind: "relay", cdpUrl: "http://127.0.0.1:9224" };
		workers[0]!.crash();
		const result = await run();
		expect(result.returnValue).toEqual({
			contents: "retained upload bytes",
			loading: true,
			focused: ownsTarget,
			group: ownsTarget ? "composition-owner" : undefined,
		});
		expect(result.displays).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("since the last call") }),
		]);
		expect((await run()).displays).toEqual([]);
		expect(workers[1]!.downloadBehaviors).toEqual([expect.objectContaining({ behavior: "allow" })]);
		await releaseTab(tab.name, { kill: false });
		expect(await Bun.file(file).text()).toBe("retained upload bytes");
	});

	it("fails the crashed call without replay and resumes its headless page with GUID download isolation", async () => {
		const { workers, tab, run } = await fixture();
		workers[0]!.failure = "exit";
		await expect(run()).rejects.toThrow("the tab is being reattached");
		const result = await run();
		expect(result.returnValue).toMatchObject({ contents: "retained upload bytes", loading: true, focused: true });
		expect(result.displays).toEqual([]);
		expect(workers.map(worker => worker.runs)).toEqual([1, 1]);
		expect(workers[1]!.downloadBehaviors).toEqual([expect.objectContaining({ behavior: "allowAndName" })]);
		expect(getTab(tab.name)).toBe(tab);
	});

	it.each([false, true])("stops repeated crashes and closes only owned relay targets (owned=%s)", async ownsTarget => {
		const close = spyOn(relayOwnedTargets, "closeRelayTarget").mockResolvedValue(true);
		const { workers, tab, browser, file, run } = await fixture();
		tab.kindTag = "relay";
		tab.ownsTarget = ownsTarget;
		browser.kind = { kind: "relay", cdpUrl: "http://127.0.0.1:9224" };
		workers[0]!.failure = "exit";
		await expect(run()).rejects.toThrow("the tab is being reattached");
		await run();
		workers[1]!.failure = "exit";
		await expect(run()).rejects.toThrow("again right after being replaced");
		await releaseTab(tab.name, { kill: false });
		expect(getTab(tab.name)).toBeUndefined();
		expect(workers).toHaveLength(2);
		expect(close).toHaveBeenCalledTimes(ownsTarget ? 1 : 0);
		if (ownsTarget) expect(close).toHaveBeenCalledWith("ws://127.0.0.1:9224/cdp", "composition-target");
		expect(await Bun.file(file).text()).toBe("retained upload bytes");
	});

	it("closes the original headless target and removes uploads after a repeated exit", async () => {
		const close = spyOn(orphanRegistry, "closeCdpTarget").mockResolvedValue(true);
		const { workers, tab, file, run } = await fixture();
		workers[0]!.crash();
		await run();
		workers[1]!.crash();
		await releaseTab(tab.name, { kill: false });
		expect(await Bun.file(file).exists()).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith(tab.browser.browser, "composition-target");
		expect(getTab(tab.name)).toBeUndefined();
	});

	it("permits another recovery at the exact ten-second boundary", async () => {
		const { workers, tab, run } = await fixture();
		workers[0]!.crash();
		await run();
		const clock = spyOn(Date, "now").mockReturnValue(tab.workerExitedAt! + 10_000);
		workers[1]!.crash();
		clock.mockRestore();
		expect((await run()).returnValue).toMatchObject({ contents: "retained upload bytes", loading: true });
		expect(workers).toHaveLength(3);
	});

	it("cancels a waiter before its deadline while recovery remains blocked, and separately enforces the deadline", async () => {
		const { workers, tab, session, run } = await fixture();
		const gate = Promise.withResolvers<void>();
		const terminate = tab.worker.terminate.bind(tab.worker);
		spyOn(tab.worker, "terminate").mockImplementation(async () => {
			await gate.promise;
			await terminate();
		});
		workers[0]!.crash();
		const abort = new AbortController();
		const scheduleTurn = setImmediate;
		vi.useFakeTimers();
		let settled = false;
		const canceled = runInTab(tab.name, { code: "never runs", timeoutMs: 30_000, signal: abort.signal, session })
			.catch((error: unknown) => error)
			.then(value => {
				settled = true;
				return value;
			});
		abort.abort();
		try {
			const checkpoint = Promise.withResolvers<void>();
			scheduleTurn(checkpoint.resolve);
			await checkpoint.promise;
			expect(settled).toBe(true);
			expect(workers).toHaveLength(1);
			expect(workers[0]!.terminated).toBe(false);
			expect(String(await canceled)).toMatch(/abort/i);
			vi.useRealTimers();
			await expect(runInTab(tab.name, { code: "never runs", timeoutMs: 10, session })).rejects.toThrow(
				"still being reattached after 10ms",
			);
			expect(workers[0]!.runs).toBe(0);
		} finally {
			vi.useRealTimers();
			gate.resolve();
			await canceled;
		}
		expect((await run()).returnValue).toMatchObject({ contents: "retained upload bytes" });
	});

	it("never sends a queued run to a different tab reopened under the same name", async () => {
		const { workers, tab, browser, session, run } = await fixture();
		const gate = Promise.withResolvers<void>();
		const terminate = tab.worker.terminate.bind(tab.worker);
		let calls = 0;
		spyOn(tab.worker, "terminate").mockImplementation(async () => {
			if (calls++ === 0) await gate.promise;
			await terminate();
		});
		workers[0]!.crash();
		const queued = run().catch((error: unknown) => String(error));
		try {
			await releaseTab(tab.name, { kill: false });
			browser.refCount += 2;
			const replacement = await acquireTab(tab.name, browser, {
				timeoutMs: 1_000,
				ownerSessionId: "replacement-owner",
			});
			if (replacement.tab.backend !== "worker") throw new Error("Expected worker tab");
			opened.push({ name: tab.name, uploadDir: replacement.tab.uploadDir });
			await Bun.write(path.join(replacement.tab.uploadDir, "pick.txt"), "replacement page");
			gate.resolve();
			expect(await queued).toContain("was closed while its worker was being reattached");
			expect(workers[1]!.runs).toBe(0);
			expect(
				(await runInTab(tab.name, { code: "read replacement", timeoutMs: 1_000, session })).returnValue,
			).toMatchObject({ contents: "replacement page" });
			expect(getTab(tab.name)?.ownerSessionId).toBe("replacement-owner");
		} finally {
			gate.resolve();
		}
	});

	it("ignores an obsolete worker exit and excludes earlier decode errors from the crash cause", async () => {
		const { workers, run } = await fixture();
		workers[0]!.dispatchEvent(new MessageEvent("messageerror", { data: "stale decode error" }));
		workers[0]!.failure = "exit";
		const failure = await run().catch((error: unknown) => String(error));
		expect(failure).toContain("exit code 3)");
		expect(failure).not.toContain("stale decode error");
		await run();
		workers[0]!.crash();
		expect((await run()).returnValue).toMatchObject({ contents: "retained upload bytes" });
		expect(workers).toHaveLength(2);
	});
});

describe("browser print and eval runtime composition", () => {
	it("routes browser facade notices through print while returning values without obsolete display globals", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: `browser-facade-${crypto.randomUUID()}` });
		const output = new RunOutput();
		const calls: unknown[] = [];
		const hooks: RuntimeHooks = {
			onText: text => output.pushText(text),
			onDisplay: value => output.pushDisplay(value),
			callTool: async (name, args) => {
				calls.push({ name, args });
				return { text: "recovered same page", details: { value: 42 } };
			},
		};
		try {
			runtime.syncPreludes([{ name: "browser", exports: ["browser"], source: browserPrelude }]);
			expect(await runtime.run('return await browser.tab("owned-tab").run("return 42;");', undefined, hooks)).toBe(
				42,
			);
			expect(calls).toEqual([
				{
					name: "__prelude__",
					args: { name: "browser", parameters: { action: "run", name: "owned-tab", code: "return 42;" } },
				},
			]);
			expect(output.finish()).toEqual([{ type: "text", text: "recovered same page" }]);
		} finally {
			runtime.dispose();
		}
	});

	it("keeps printed object text once and images ordered in the browser result", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: `browser-print-${crypto.randomUUID()}` });
		const output = new RunOutput();
		let views = 0;
		const hooks: RuntimeHooks = {
			onText: text => output.pushText(text),
			onDisplay: value => {
				if (value.type === "view") views++;
				output.pushDisplay(value);
			},
			callTool: async () => undefined,
		};
		try {
			await runtime.run(
				'print({ items: Array.from({ length: 20 }, (_, i) => ({ id: i })) }); print({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }); print("after image");',
				undefined,
				hooks,
			);
			const entries = output.finish();
			expect(views).toBe(1);
			expect(entries.map(entry => entry.type)).toEqual(["text", "image", "text"]);
			expect(entries[0]?.type === "text" && entries[0].text.match(/items:/g)?.length).toBe(1);
			expect(entries[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
			expect(entries[2]).toEqual({ type: "text", text: "after image" });
		} finally {
			runtime.dispose();
		}
	});
});
