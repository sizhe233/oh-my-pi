/** Real Chromium + unpacked-extension integration checks. No CLI/native addon or model calls. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type WebWorker } from "puppeteer-core";
import { startRelayServer, type RelayServer } from "../packages/coding-agent/src/tools/browser/relay/server";

type Status = "pass" | "partial" | "blocked" | "fail";
interface CaseResult {
	case: number;
	status: Status;
	evidence: string;
}
interface Tab {
	id: number;
	active: boolean;
	url: string;
	groupId: number;
	windowId: number;
}
interface Group {
	id: number;
	title: string;
}
interface Target {
	targetId: string;
	url: string;
}
const reportDir = path.resolve(process.env.OMP_E2E_REPORT_DIR ?? "artifacts/browser-relay-e2e");
const executablePath = process.env.OMP_E2E_BROWSER_PATH;
const extensionDir = path.resolve(process.env.OMP_E2E_EXTENSION_DIR ?? "packages/browser-relay/dist/extension");
const cases: CaseResult[] = [];
const browsers: Browser[] = [];
const clients: CdpClient[] = [];
const logs: Array<{ time?: number; message?: string; data?: Record<string, unknown>; cleanup?: string }> = [];
let relay: RelayServer | undefined;
let profileRoot: string | undefined;
let version = "not launched";
let failure: string | undefined;
let currentCase = 1;
let launched = false;
const startedAt = new Date().toISOString();
function result(n: number, status: Status, evidence: string): void {
	cases.push({ case: n, status, evidence });
	console.log(`case ${n}: ${status}: ${evidence}`);
}
async function until<T>(
	label: string,
	check: () => Promise<T | undefined | false>,
	timeout = 15_000,
	diagnostics?: () => unknown,
): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await check();
		if (value !== undefined && value !== false) return value;
		await Bun.sleep(100);
	}
	throw new Error(
		`Timed out: ${label} (${timeout} ms)${diagnostics ? `; last observation: ${JSON.stringify(diagnostics())}` : ""}`,
	);
}
class CdpClient {
	#socket: WebSocket;
	#seq = 0;
	#pending = new Map<
		number,
		{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", event => {
			const message = JSON.parse(String(event.data));
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result ?? {});
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("CDP connection closed"));
			}
			this.#pending.clear();
		});
	}
	static async connect(port: number): Promise<CdpClient> {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
		const ready = Promise.withResolvers<void>();
		socket.addEventListener("open", () => ready.resolve(), { once: true });
		socket.addEventListener("error", () => ready.reject(new Error("CDP WebSocket failed")), { once: true });
		await ready.promise;
		const client = new CdpClient(socket);
		clients.push(client);
		return client;
	}
	async send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		const id = ++this.#seq;
		const deferred = Promise.withResolvers<Record<string, unknown>>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			deferred.reject(new Error(`CDP timeout: ${method}`));
		}, 15_000);
		this.#pending.set(id, { ...deferred, timer });
		this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
		return (await deferred.promise) as T;
	}
	async attach(targetId: string): Promise<string> {
		return (await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
	}
	close(): void {
		this.#socket.close();
	}
}
async function tabs(worker: WebWorker): Promise<Tab[]> {
	return (await worker.evaluate("chrome.tabs.query({})")) as Tab[];
}
async function groups(worker: WebWorker): Promise<Group[]> {
	return (await worker.evaluate("chrome.tabGroups.query({})")) as Group[];
}
async function targets(client: CdpClient): Promise<Target[]> {
	return (await client.send<{ targetInfos: Target[] }>("Target.getTargets")).targetInfos;
}
async function launch(
	port: number,
	label: string,
	windowless = false,
): Promise<{ browser: Browser; worker: WebWorker }> {
	const browser = await puppeteer.launch({
		executablePath,
		headless: process.env.OMP_E2E_HEADLESS !== "false",
		userDataDir: path.join(profileRoot!, label),
		enableExtensions: [extensionDir],
		pipe: true,
		// Puppeteer observes only the extension worker. Its default auto-attachment
		// to page/tab targets would make debugger.getTargets().attached measure
		// the test observer as well as the relay, invalidating detach assertions.
		targetFilter: target => target.type() === "service_worker",
		waitForInitialPage: false,
		ignoreDefaultArgs: windowless ? ["about:blank"] : [],
		args: windowless ? ["--no-startup-window"] : [],
		dumpio: true,
	});
	browsers.push(browser);
	const target = await browser.waitForTarget(
		t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
		{ timeout: 20_000 },
	);
	const worker = await target.worker();
	assert(worker, "Extension service worker did not start");
	await worker.evaluate(`chrome.storage.local.set({port: ${port}})`);
	if (!windowless) await until("normal browser has its startup tab", async () => (await tabs(worker)).length > 0);
	return { browser, worker };
}
async function expectConflict(client: CdpClient, session: string): Promise<void> {
	await assert.rejects(client.send("OMP.claimTarget", {}, session), /already driven by another omp session/);
}
try {
	assert(executablePath, "Set OMP_E2E_BROWSER_PATH to a Chromium/Chrome for Testing executable");
	assert(await Bun.file(path.join(extensionDir, "manifest.json")).exists(), "Build the unpacked extension first");
	profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-e2e-"));
	const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = reserve.port!;
	reserve.stop(true);
	const start = () =>
		startRelayServer({ port, log: (message, data) => logs.push({ time: Date.now(), message, data }) });
	relay = start();
	const first = await launch(port, "first");
	version = await first.browser.version();
	launched = true;
	await until("extension handshake", async () => relay?.bridge.ready);
	const userUrl = "data:text/html,<title>User tab</title><body style='background:rgb(10,20,200)'>User tab";
	const userTab = (await first.worker.evaluate(
		`chrome.tabs.create({url:${JSON.stringify(userUrl)},active:true})`,
	)) as Tab;
	const creator = await CdpClient.connect(port);
	await until("user target discovery", async () =>
		(await targets(creator)).some(t => t.targetId.endsWith(`.${userTab.id}`)),
	);
	const userTarget = (await targets(creator)).find(t => t.targetId.endsWith(`.${userTab.id}`))!;
	const before = (await tabs(first.worker)).filter(t => t.active).map(t => t.id);
	const ownedUrl =
		"data:text/html,<title>Owned red target</title><style>html,body{margin:0;background:rgb(210,30,50);width:100%;height:100%}</style>";
	const owned = await creator.send<{ targetId: string }>("Target.createTarget", { url: ownedUrl });
	const ownedTabId = Number(owned.targetId.split(".").at(-1));
	await until("owned background tab", async () => (await tabs(first.worker)).find(t => t.id === ownedTabId));
	assert.deepEqual(
		(await tabs(first.worker)).filter(t => t.active).map(t => t.id),
		before,
	);
	assert.notEqual(ownedTabId, userTab.id);
	result(
		1,
		"partial",
		"Actual extension created a distinct background tab; active tab unchanged. CLI browser.open and OS foreground-app focus are not measured.",
	);

	currentCase = 6;
	const worker = await CdpClient.connect(port);
	const session = await worker.attach(owned.targetId);
	const competitor = await CdpClient.connect(port);
	const competingSession = await competitor.attach(owned.targetId);
	await expectConflict(competitor, competingSession);
	await worker.send("OMP.claimTarget", { ownsTarget: true, label: "e2e-owner" }, session);
	await expectConflict(competitor, competingSession);
	result(
		6,
		"partial",
		"Real creator connection handed its provisional claim to a separate owned-worker connection, without a gap admitting a competing claim. Native supervisor/worker processes are not exercised.",
	);
	currentCase = 3;
	await worker.send("Target.detachFromTarget", { sessionId: session });
	worker.close();
	await until("claim release", async () => {
		try {
			await competitor.send("OMP.claimTarget", { label: "e2e-owner" }, competingSession);
			return true;
		} catch (error) {
			if (String(error).includes("already driven")) return false;
			throw error;
		}
	});
	result(
		3,
		"pass",
		"Second real relay client was rejected with the expected conflict message and could claim only after the first driver released.",
	);

	currentCase = 2;
	await competitor.send("Page.enable", {}, competingSession);
	await until("owned document loaded", async () => {
		const value = await competitor.send<{ result: { value?: string } }>(
			"Runtime.evaluate",
			{ expression: "document.title", returnByValue: true },
			competingSession,
		);
		return value.result.value === "Owned red target";
	});
	await competitor.send("Emulation.setFocusEmulationEnabled", { enabled: true }, competingSession);
	const { png, pixels } = await until("target pixels rendered in background screenshot", async () => {
		const screenshot = await competitor.send<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "png", fromSurface: true, captureBeyondViewport: true },
			competingSession,
		);
		const png = Buffer.from(screenshot.data, "base64");
		assert.equal(png.subarray(1, 4).toString(), "PNG");
		assert(png.readUInt32BE(16) > 100 && png.readUInt32BE(20) > 100);
		await Bun.write(path.join(reportDir, "owned-background.png"), png);
		// Decode actual captured pixels, not DOM colors; retain the last PNG on failure.
		const pixels = (await first.worker.evaluate(
			`(async () => { const blob = await (await fetch('data:image/png;base64,${screenshot.data}')).blob(); const image = await createImageBitmap(blob); const canvas = new OffscreenCanvas(image.width,image.height); const context=canvas.getContext('2d'); context.drawImage(image,0,0); return Array.from(context.getImageData(20,20,1,1).data); })()`,
		)) as number[];
		assert.deepEqual(
			(await tabs(first.worker)).filter(t => t.active).map(t => t.id),
			before,
		);
		if (pixels.join(",") !== "210,30,50,255") return false;
		return { png, pixels };
	});
	result(
		2,
		"partial",
		`Real background PNG (${png.readUInt32BE(16)}x${png.readUInt32BE(20)}) contains target pixels [${pixels}]; active tab unchanged. CLI screenshot preparation and OS focus are not exercised.`,
	);

	currentCase = 4;
	const secondOwned = await creator.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
	const secondSession = await creator.attach(secondOwned.targetId);
	await creator.send("OMP.claimTarget", { label: "e2e-other" }, secondSession);
	await until("distinct named real tab groups", async () => {
		const titles = (await groups(first.worker)).map(g => g.title);
		return titles.includes("omp/e2e-owner") && titles.includes("omp/e2e-other");
	});
	const groupEvidence = await groups(first.worker);

	currentCase = 9;
	const reaper = await CdpClient.connect(port);
	assert.deepEqual(await reaper.send("OMP.closeOwnedTarget", { targetId: userTarget.targetId }), { closed: false });
	assert.deepEqual(await reaper.send("OMP.closeOwnedTarget", { targetId: owned.targetId }), { closed: false });
	await creator.send("Target.detachFromTarget", { sessionId: secondSession });
	creator.close();
	await until(
		"unclaimed owned tab reaped",
		async () =>
			(await reaper.send<{ closed: boolean }>("OMP.closeOwnedTarget", { targetId: secondOwned.targetId })).closed,
	);
	assert((await tabs(first.worker)).some(t => t.id === userTab.id));
	assert((await tabs(first.worker)).some(t => t.id === ownedTabId));
	result(
		9,
		"partial",
		"Real ownership-close command rejected a user tab and a live-owned tab, and removed an unclaimed extension-created tab. PID registry, SIGKILL recovery, restart ID reuse, and native runtime chain are not exercised.",
	);

	currentCase = 5;
	const borrowed = await reaper.attach(userTarget.targetId);
	await reaper.send("OMP.claimTarget", { label: "e2e-borrowed" }, borrowed);
	await reaper.send("Target.detachFromTarget", { sessionId: borrowed });
	reaper.close();
	await competitor.send("Target.closeTarget", { targetId: owned.targetId });
	competitor.close();
	let detachObservation: Record<string, unknown> = {};
	await until(
		"owned gone and debugger detached",
		async () => {
			const remaining = await tabs(first.worker);
			const debuggerTargets = (await first.worker.evaluate(
				"chrome.debugger.getTargets().then(items => items.filter(t => t.tabId !== undefined))",
			)) as Array<{ id: string; tabId: number; attached: boolean; url: string; title: string }>;
			const attached = debuggerTargets.filter(target => target.attached);
			detachObservation = { ownedTabId, userTabId: userTab.id, remaining, debuggerTargets };
			return (
				!remaining.some(t => t.id === ownedTabId) &&
				remaining.some(t => t.id === userTab.id) &&
				attached.length === 0
			);
		},
		15_000,
		() => detachObservation,
	);
	logs.push({ time: Date.now(), message: "owned close and debugger detach observed", data: detachObservation });
	result(
		5,
		"partial",
		"Explicit owned close removed the real owned tab; borrowed user tab survived; chrome.debugger reports no attached tab targets after release. CLI shutdown and visual debugger banner are not exercised.",
	);

	// Leave a real claimed group present so disconnect cleanup is actually tested.
	const disconnectClient = await CdpClient.connect(port);
	const disconnectSession = await disconnectClient.attach(userTarget.targetId);
	await disconnectClient.send("OMP.claimTarget", { label: "e2e-disconnect" }, disconnectSession);
	await until("disconnect group exists", async () =>
		(await groups(first.worker)).some(g => g.title === "omp/e2e-disconnect"),
	);
	currentCase = 4;
	relay.stop();
	relay = undefined;
	await until("groups dissolved on real socket disconnect", async () =>
		(await groups(first.worker)).every(g => g.title !== "omp" && !g.title.startsWith("omp/")),
	);
	result(
		4,
		"pass",
		`Observed distinct real Chrome groups ${JSON.stringify(groupEvidence)} and all omp groups dissolved after relay disconnect.`,
	);
	currentCase = 10;
	await Bun.sleep(1500);
	const reconnectStart = Date.now();
	relay = start();
	await until("automatic extension reconnect", async () => relay?.bridge.ready, 35_000);
	const reconnectMs = Date.now() - reconnectStart;
	const recovered = await CdpClient.connect(port);
	assert((await targets(recovered)).some(t => t.targetId === userTarget.targetId));
	result(
		10,
		"partial",
		`Extension automatically reconnected after a real relay stop/start in ${reconnectMs} ms, with stable target identity. Chrome extensions error-list noise and timer-chain count are not measured.`,
	);

	currentCase = 11;
	const second = await launch(port, "second");
	const secondUser = (await second.worker.evaluate(
		"chrome.tabs.create({url:'data:text/html,<title>second-instance</title>',active:true})",
	)) as Tab;
	await until("second browser handshake", async () => {
		const instance = (await second.worker.evaluate(
			"chrome.storage.local.get('relayInstanceId').then(s => s.relayInstanceId)",
		)) as string;
		return logs.some(entry => entry.message === "extension connected" && entry.data?.instanceId === instance);
	});
	await until("second browser discovery", async () =>
		(await targets(recovered)).some(t => t.url.includes("second-instance")),
	);
	const routed = await recovered.send<{ targetId: string }>("Target.createTarget", {
		url: "data:text/html,<title>routed-to-second</title>",
	});
	// createTab resolves before navigation commits; observe the actual tab's
	// committed URL rather than treating pending navigation as wrong routing.
	await until("created tab committed in second browser", async () =>
		(await tabs(second.worker)).some(t => t.url.includes("routed-to-second")),
	);
	assert(!(await tabs(first.worker)).some(t => t.url.includes("routed-to-second")));
	assert((await tabs(second.worker)).find(t => t.id === secondUser.id)?.active);
	await recovered.send("Target.closeTarget", { targetId: routed.targetId });
	// Third instance has a live extension but no browser windows/tabs.
	const empty = await launch(port, "windowless", true);
	await until("windowless extension handshake", async () => {
		const instance = (await empty.worker.evaluate(
			"chrome.storage.local.get('relayInstanceId').then(s => s.relayInstanceId)",
		)) as string;
		return logs.some(entry => entry.message === "extension connected" && entry.data?.instanceId === instance);
	});
	assert.equal((await tabs(empty.worker)).length, 0, "Windowless profile must really have no tabs");
	const fallback = await recovered.send<{ targetId: string }>("Target.createTarget", {
		url: "data:text/html,<title>windowless-fallback</title>",
	});
	assert.equal((await tabs(empty.worker)).length, 0);
	await until("fallback tab committed in a populated browser", async () =>
		[...(await tabs(first.worker)), ...(await tabs(second.worker))].some(t => t.url.includes("windowless-fallback")),
	);
	await recovered.send("Target.closeTarget", { targetId: fallback.targetId });
	result(
		11,
		"pass",
		"Real multi-profile browsers routed creation to the last connected populated instance; a subsequently connected windowless extension did not receive new tabs.",
	);
} catch (error) {
	failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
	result(currentCase, launched ? "fail" : "blocked", failure);
	process.exitCode = 1;
} finally {
	for (const client of clients) client.close();
	relay?.stop();
	for (const browser of browsers.reverse()) {
		try {
			await browser.close();
		} catch (error) {
			logs.push({ cleanup: String(error) });
		}
	}
	if (profileRoot)
		await fs.rm(profileRoot, { recursive: true, force: true }).catch(error => logs.push({ cleanup: String(error) }));
	for (let n = 1; n <= 11; n++) {
		if (cases.some(entry => entry.case === n)) continue;
		const reason =
			n === 7
				? "OS minimized-window and focus behavior requires a real desktop acceptance run."
				: n === 8
					? "Target mismatch is implemented in native CLI supervisor; this extension harness does not exercise it."
					: "Earlier failure prevented this dependent real-browser check.";
		result(n, "blocked", reason);
	}
	const report = {
		sourceSha: process.env.OMP_E2E_SOURCE_SHA ?? null,
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		startedAt,
		finishedAt: new Date().toISOString(),
		browserVersion: version,
		executablePath,
		extensionDir,
		headless: process.env.OMP_E2E_HEADLESS !== "false",
		scope: "Real isolated Chromium + extension + relay CDP integration; not full user Chrome/CLI acceptance",
		status: failure ? "fail" : "partial",
		cases: cases.sort((a, b) => a.case - b.case),
		failure,
	};
	await Bun.write(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	await Bun.write(path.join(reportDir, "relay-log.json"), `${JSON.stringify(logs, null, 2)}\n`);
}
