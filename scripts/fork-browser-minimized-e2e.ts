/** Headed-only Windows diagnostic: isolated CfT + real extension/relay, no window restoration. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type CDPSession, type ConnectionTransport, type WebWorker } from "puppeteer-core";
import { startRelayServer, type RelayServer } from "../packages/coding-agent/src/tools/browser/relay/server";

const reportDir = path.resolve(process.env.OMP_E2E_REPORT_DIR ?? "artifacts/browser-minimized-e2e");
const extensionDir = path.resolve(process.env.OMP_E2E_EXTENSION_DIR ?? "packages/browser-relay/dist/extension");
const diagnostics: Array<Record<string, unknown>> = [];
const results: Array<Record<string, unknown>> = [];
const timeoutMs = 5_000;
// Diagnostic A/B only: never a production launch flag or a proposed product fix.
const enableNewSurfaceDiagnostic = process.env.OMP_E2E_ENABLE_NEW_SURFACE === "true";
let observer: Browser | undefined;
let relay: RelayServer | undefined;
let profile: string | undefined;
let worker: WebWorker;
let port: number;
let failure: string | undefined;
let version: string | undefined;
const startedAt = new Date().toISOString();
function log(entry: Record<string, unknown>): void {
	const record = { at: new Date().toISOString(), ...entry };
	diagnostics.push(record);
	console.log(JSON.stringify(record));
}
async function step<T>(name: string, action: () => Promise<T>, timeout = 12_000): Promise<T> {
	log({ step: name, phase: "start" });
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Stage timeout: ${name} (${timeout}ms)`)), timeout);
	try {
		const value = await Promise.race([action(), deadline.promise]);
		log({ step: name, phase: "end", status: "pass" });
		return value;
	} catch (error) {
		log({ step: name, phase: "end", status: "fail", error: String(error) });
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
async function until(name: string, test: () => Promise<boolean>): Promise<void> {
	await step(
		name,
		async () => {
			while (!(await test())) await Bun.sleep(100);
		},
		25_000,
	);
}
/** Log CDP method timing without writing protocol payloads/screenshots into logs. */
class TraceTransport implements ConnectionTransport {
	onmessage?: (message: string) => void;
	onclose?: () => void;
	#socket: WebSocket;
	#pending = new Map<number, { method: string; time: number }>();
	constructor(
		socket: WebSocket,
		readonly label: string,
	) {
		this.#socket = socket;
		socket.addEventListener("message", event => {
			const raw = String(event.data);
			const message = JSON.parse(raw);
			const pending = this.#pending.get(message.id);
			if (pending) {
				log({
					connection: label,
					method: pending.method,
					phase: "end",
					elapsedMs: Date.now() - pending.time,
					error: message.error,
				});
				this.#pending.delete(message.id);
			}
			this.onmessage?.(raw);
		});
		socket.addEventListener("close", () => this.onclose?.());
	}
	static async open(label: string): Promise<TraceTransport> {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
		const ready = Promise.withResolvers<void>();
		socket.addEventListener("open", () => ready.resolve(), { once: true });
		socket.addEventListener("error", () => ready.reject(new Error("Relay WebSocket failed")), { once: true });
		await step(`${label}:connect-websocket`, () => ready.promise);
		return new TraceTransport(socket, label);
	}
	send(raw: string): void {
		const message = JSON.parse(raw);
		this.#pending.set(message.id, { method: message.method, time: Date.now() });
		log({ connection: this.label, method: message.method, phase: "start", id: message.id });
		this.#socket.send(raw);
	}
	close(): void {
		for (const [id, pending] of this.#pending)
			log({
				connection: this.label,
				id,
				method: pending.method,
				phase: "unfinished-at-close",
				elapsedMs: Date.now() - pending.time,
			});
		this.#socket.close();
	}
}
class RawClient {
	#seq = 0;
	#transport: TraceTransport;
	#pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	constructor(transport: TraceTransport) {
		this.#transport = transport;
		transport.onmessage = raw => {
			const message = JSON.parse(raw);
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result ?? {});
		};
	}
	async send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		const id = ++this.#seq;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending.set(id, deferred);
		const timer = setTimeout(() => deferred.reject(new Error(`CDP timeout: ${method} (${timeoutMs}ms)`)), timeoutMs);
		try {
			this.#transport.send(JSON.stringify({ id, method, params, sessionId }));
			return (await deferred.promise) as T;
		} finally {
			clearTimeout(timer);
			this.#pending.delete(id);
		}
	}
	close(): void {
		this.#transport.close();
	}
}
interface ForegroundSnapshot {
	available: boolean;
	handle?: string;
	processId?: number;
	sessionId?: number;
	reason?: string;
}
let foregroundBefore: ForegroundSnapshot | undefined;
let foregroundAfter: ForegroundSnapshot | undefined;
async function foregroundSnapshot(label: string): Promise<ForegroundSnapshot> {
	const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class OmpForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }'; $h=[OmpForeground]::GetForegroundWindow(); [uint32]$owner=0; [void][OmpForeground]::GetWindowThreadProcessId($h,[ref]$owner); @{handle=$h.ToInt64().ToString(); processId=$owner; sessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId} | ConvertTo-Json -Compress`;
	let process: Bun.Subprocess | undefined;
	try {
		process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const child = process;
		const output = await step(`${label}:Win32-foreground`, async () => {
			assert(child.stdout instanceof ReadableStream, "PowerShell stdout is not a stream");
			const stdout = await new Response(child.stdout).text();
			assert.equal(await child.exited, 0, "PowerShell foreground query failed");
			return JSON.parse(stdout) as { handle: string; processId: number; sessionId: number };
		});
		const snapshot = {
			...output,
			available: output.handle !== "0" && output.sessionId !== 0,
			reason:
				output.handle === "0" || output.sessionId === 0 ? "No measurable interactive foreground window" : undefined,
		};
		log({ observation: label, foreground: snapshot });
		return snapshot;
	} catch (error) {
		const snapshot = { available: false, reason: String(error) };
		log({ observation: label, foreground: snapshot });
		return snapshot;
	} finally {
		process?.kill();
	}
}
interface WindowState {
	id: number;
	state: string;
	focused: boolean;
}
async function checkMinimized(label: string): Promise<void> {
	const windows = (await step(`${label}:window-states`, () =>
		worker.evaluate("chrome.windows.getAll({windowTypes:['normal']})"),
	)) as WindowState[];
	log({ observation: label, windows: windows.map(({ id, state, focused }) => ({ id, state, focused })) });
	assert(windows.length > 0, "No normal Chrome window exists");
	assert(
		windows.every(window => window.state === "minimized" && !window.focused),
		"A window was restored or focused during minimized test",
	);
}
interface Metrics {
	width: number;
	height: number;
	fullHeight: number;
	documentWidth: number;
	clientWidth: number;
	dpr: number;
}
const metricsExpression =
	"({width:innerWidth,height:innerHeight,documentWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),clientWidth:document.documentElement.clientWidth,fullHeight:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight),dpr:devicePixelRatio})";
const boundedFrameExpression = "new Promise(resolve=>requestAnimationFrame(()=>resolve('animation-frame')))";
async function validatePng(
	name: string,
	bytes: Uint8Array,
	rgb: number[],
	metrics: Metrics,
	fullPage: boolean | undefined,
): Promise<void> {
	const png = Buffer.from(bytes);
	await Bun.write(path.join(reportDir, `${name}.png`), png);
	assert.equal(png.subarray(1, 4).toString(), "PNG");
	const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
	assert(dimensions.width > 100 && dimensions.height > 100);
	if (fullPage !== undefined) {
		const validWidths = (
			fullPage ? [metrics.width, metrics.documentWidth, metrics.clientWidth] : [metrics.width]
		).map(width => Math.round(width * metrics.dpr));
		assert(
			validWidths.includes(dimensions.width),
			`Screenshot width ${dimensions.width} is not one of measured widths ${validWidths.join(", ")}`,
		);
		assert.equal(
			dimensions.height,
			Math.round((fullPage ? metrics.fullHeight : metrics.height) * metrics.dpr),
			"Screenshot height mismatch",
		);
	}
	const pixels = (await step(`${name}:decode-pixels`, () =>
		worker.evaluate(
			`(async()=>{const b=await(await fetch('data:image/png;base64,${png.toString("base64")}')).blob();const image=await createImageBitmap(b);const canvas=new OffscreenCanvas(image.width,image.height);const c=canvas.getContext('2d');c.drawImage(image,0,0);return [Array.from(c.getImageData(20,20,1,1).data),Array.from(c.getImageData(20,image.height-20,1,1).data)]})()`,
		),
	)) as number[][];
	for (const pixel of pixels)
		assert.deepEqual(pixel, [...rgb, 255], "Screenshot is stale or contains incorrect fixture pixels");
	log({ image: `${name}.png`, dimensions, pixels, metrics });
	await checkMinimized(name);
}
const modes = [
	"raw-default",
	"raw-beyond",
	"raw-explicit-clip",
	"raw-device-metrics",
	"raw-screencast",
	"raw-lifecycle-active",
	"raw-direct-browser",
	"puppeteer-viewport",
	"puppeteer-fullpage",
] as const;
try {
	assert.equal(
		process.platform,
		"win32",
		"This is a Windows headed reproducer; do not count other platforms as Windows coverage",
	);
	assert(process.env.OMP_E2E_HEADLESS !== "true", "Headless mode is forbidden for this reproducer");
	assert(process.env.OMP_E2E_BROWSER_PATH, "Set OMP_E2E_BROWSER_PATH");
	assert(await Bun.file(path.join(extensionDir, "manifest.json")).exists(), "Build extension first");
	await fs.mkdir(reportDir, { recursive: true });
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-minimized-e2e-"));
	const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	port = reservation.port!;
	reservation.stop(true);
	relay = startRelayServer({ port, log: (message, data) => log({ relay: message, data }) });
	observer = await step(
		"launch-headed-CfT",
		() =>
			puppeteer.launch({
				executablePath: process.env.OMP_E2E_BROWSER_PATH,
				headless: false,
				// Isolated diagnostic A/B only; this is not a fix for an existing user's browser.
				args:
					process.env.OMP_E2E_ENABLE_NEW_SURFACE === "true" ? ["--enable-features=CDPScreenshotNewSurface"] : [],
				userDataDir: profile,
				enableExtensions: [extensionDir],
				pipe: true,
				targetFilter: target => target.type() === "service_worker",
				waitForInitialPage: false,
				dumpio: true,
			}),
		30_000,
	);
	version = await observer.version();
	const extensionTarget = await observer.waitForTarget(
		t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
		{ timeout: 20_000 },
	);
	const extensionWorker = await extensionTarget.worker();
	assert(extensionWorker);
	worker = extensionWorker;
	await worker.evaluate(`chrome.storage.local.set({port:${port}})`);
	await until("extension-handshake", async () => relay!.bridge.ready);
	await until(
		"startup-window",
		async () => ((await worker.evaluate("chrome.windows.getAll({windowTypes:['normal']})")) as unknown[]).length > 0,
	);
	await step("minimize-all-Chrome-windows", () =>
		worker.evaluate(
			"(async()=>{for(const w of await chrome.windows.getAll({windowTypes:['normal']}))await chrome.windows.update(w.id,{state:'minimized'});})()",
		),
	);
	await checkMinimized("before-any-owned-target-created");
	foregroundBefore = await foregroundSnapshot("before-owned-targets");
	for (const mode of modes) {
		let creator: RawClient | undefined;
		let browser: Browser | undefined;
		let transport: TraceTransport | undefined;
		let targetId: string | undefined;
		let captureSession: CDPSession | undefined;
		let directRoot: CDPSession | undefined;
		let directSession: CDPSession | undefined;
		let screencastStarted = false;
		let screencastFrames = 0;
		let latestScreencastData: string | undefined;
		try {
			await checkMinimized(`${mode}:before-create`);
			creator = new RawClient(await TraceTransport.open(`${mode}:creator`));
			const url = `data:text/html,${encodeURIComponent(`<title>${mode}</title><style>html,body{margin:0;width:100%;min-height:1600px;background:rgb(201,31,51)}</style>`)}`;
			({ targetId } = await step(`${mode}:create-owned-target`, () =>
				creator!.send<{ targetId: string }>("Target.createTarget", { url }),
			));
			await checkMinimized(`${mode}:after-create`);
			transport = await TraceTransport.open(`${mode}:driver`);
			browser = await step(`${mode}:puppeteer-connect`, () =>
				puppeteer.connect({ transport: transport!, defaultViewport: null, protocolTimeout: timeoutMs }),
			);
			const target = await step(`${mode}:find-target`, () =>
				browser!.waitForTarget(t => (t as unknown as { _targetId: string })._targetId === targetId, {
					timeout: timeoutMs,
				}),
			);
			const page = await step(`${mode}:target.page`, () => target.page());
			assert(page);
			const session = await step(`${mode}:create-session`, () => page.createCDPSession());
			captureSession = session;
			const raw = session as unknown as { send<T>(method: string, params?: Record<string, unknown>): Promise<T> };
			await step(`${mode}:claim-owned`, () => raw.send("OMP.claimTarget", { ownsTarget: true, label: mode }));
			await step(`${mode}:emulate-focused-page`, () => page.emulateFocusedPage(true));
			await until(`${mode}:fixture-ready`, async () => {
				const ready = await session.send("Runtime.evaluate", {
					expression: `document.title===${JSON.stringify(mode)} && !!document.body`,
					returnByValue: true,
				});
				assert(!ready.exceptionDetails, JSON.stringify(ready.exceptionDetails));
				return ready.result.value === true;
			});
			if (mode === "raw-direct-browser") {
				directRoot = await step(`${mode}:create-direct-root`, () => observer!.target().createCDPSession());
				const directTargets = await step(`${mode}:direct-Target.getTargets`, () =>
					directRoot!.send("Target.getTargets", {}, { timeout: timeoutMs }),
				);
				const directTarget = directTargets.targetInfos.find(info => info.type === "page" && info.url === url);
				assert(directTarget, "Cannot identify isolated fixture's real Chrome target");
				const attached = await step(`${mode}:direct-Target.attachToTarget`, () =>
					directRoot!.send(
						"Target.attachToTarget",
						{ targetId: directTarget.targetId, flatten: true },
						{ timeout: timeoutMs },
					),
				);
				directSession = directRoot.connection()?.session(attached.sessionId) ?? undefined;
				assert(directSession, "Direct CDP session was not registered");
				log({ mode, directTargetId: directTarget.targetId, relayTargetId: targetId });
			}
			if (mode === "raw-screencast") {
				session.on("Page.screencastFrame", event => {
					screencastFrames++;
					latestScreencastData = event.data;
					log({ mode, event: "Page.screencastFrame", frame: screencastFrames, metadata: event.metadata });
					void session
						.send("Page.screencastFrameAck", { sessionId: event.sessionId })
						.catch(error => log({ mode, acknowledgementError: String(error) }));
				});
				// Mark before send so cleanup also stops a start that timed out after reaching Chrome.
				screencastStarted = true;
				await step(`${mode}:start-screencast-candidate`, () =>
					session.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }),
				);
				await checkMinimized(`${mode}:after-start-screencast`);
			}
			if (mode === "raw-lifecycle-active") {
				await step(`${mode}:lifecycle-active-candidate`, () =>
					session.send("Page.setWebLifecycleState", { state: "active" }),
				);
				await checkMinimized(`${mode}:after-lifecycle-active`);
			}
			for (const [index, rgb] of [
				[201, 31, 51],
				[19, 71, 213],
			].entries()) {
				const name = `${mode}-${index}`;
				const mutation = await step(`${name}:Runtime.evaluate-mutate`, () =>
					session.send("Runtime.evaluate", {
						expression: `document.documentElement.style.background=document.body.style.background='rgb(${rgb.join(",")})';document.body.style.minHeight='1600px';true`,
						returnByValue: true,
					}),
				);
				assert(!mutation.exceptionDetails, JSON.stringify(mutation.exceptionDetails));
				const frame = await step(`${name}:bounded-rAF`, () =>
					Promise.race([
						session
							.send("Runtime.evaluate", {
								expression: boundedFrameExpression,
								awaitPromise: true,
								returnByValue: true,
							})
							.then(value => value.result.value),
						Bun.sleep(250).then(() => "250ms-host-fallback"),
					]),
				);
				log({ stage: name, frame });
				const observed = await step(`${name}:Runtime.evaluate-metrics`, () =>
					session.send("Runtime.evaluate", { expression: metricsExpression, returnByValue: true }),
				);
				assert(!observed.exceptionDetails, JSON.stringify(observed.exceptionDetails));
				const metrics = observed.result.value as Metrics;
				assert(metrics?.width > 100 && metrics.height > 100);
				if (mode === "raw-device-metrics") {
					await step(`${name}:device-metrics-candidate`, () =>
						session.send("Emulation.setDeviceMetricsOverride", {
							width: metrics.width,
							height: metrics.height,
							deviceScaleFactor: metrics.dpr,
							mobile: false,
						}),
					);
				}
				let png: Uint8Array;
				if (mode.startsWith("puppeteer")) {
					png = await step(`${name}:page.screenshot`, () =>
						page.screenshot({ type: "png", fullPage: mode === "puppeteer-fullpage" }),
					);
				} else {
					const capture = await step(`${name}:Page.captureScreenshot`, () =>
						(directSession ?? session).send(
							"Page.captureScreenshot",
							{
								format: "png",
								fromSurface: true,
								captureBeyondViewport: ["raw-beyond", "raw-explicit-clip", "raw-device-metrics"].includes(mode),
								...(mode === "raw-explicit-clip"
									? { clip: { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 } }
									: {}),
							},
							{ timeout: timeoutMs },
						),
					);
					png = Buffer.from(capture.data, "base64");
				}
				await validatePng(
					name,
					png,
					rgb,
					metrics,
					mode === "raw-beyond" || mode === "raw-device-metrics" ? undefined : mode === "puppeteer-fullpage",
				);
				if (mode === "raw-device-metrics")
					await step(`${name}:clear-device-metrics`, () => session.send("Emulation.clearDeviceMetricsOverride"));
				if (mode === "raw-screencast") {
					const framesBeforeMutation = screencastFrames;
					await step(`${name}:mutate-after-capture`, () =>
						session.send("Runtime.evaluate", {
							expression:
								"document.documentElement.style.background=document.body.style.background='rgb(71,213,19)'",
							returnByValue: true,
						}),
					);
					await until(`${name}:existing-screencast-still-emits`, async () => {
						if (screencastFrames <= framesBeforeMutation || !latestScreencastData) return false;
						const pixel = (await worker.evaluate(
							`(async()=>{const blob=await(await fetch('data:image/png;base64,${latestScreencastData}')).blob();const image=await createImageBitmap(blob);const canvas=new OffscreenCanvas(image.width,image.height);const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return Array.from(ctx.getImageData(20,20,1,1).data)})()`,
						)) as number[];
						return pixel.join(",") === "71,213,19,255";
					});
					log({
						mode,
						name,
						framesBeforeMutation,
						framesAfterMutation: screencastFrames,
						recordingContinuity: "Frames continued after screenshot without another startScreencast call",
					});
				}
			}
			results.push({ mode, status: "pass", gating: mode !== "raw-direct-browser" });
		} catch (error) {
			results.push({ mode, status: "fail", error: String(error), gating: mode !== "raw-direct-browser" });
			log({ mode, failure: String(error) });
		} finally {
			if (screencastStarted && captureSession) {
				await step(`${mode}:stop-screencast`, () => captureSession!.send("Page.stopScreencast")).catch(error =>
					log({ cleanup: "stop-screencast", error: String(error) }),
				);
				log({ mode, screencastFrames });
				await checkMinimized(`${mode}:after-stop-screencast`).catch(error =>
					log({ cleanup: "window-check", error: String(error) }),
				);
			}
			if (directSession)
				await step(`${mode}:detach-direct-session`, () => directSession!.detach()).catch(error =>
					log({ cleanup: "detach-direct-session", error: String(error) }),
				);
			if (directRoot)
				await step(`${mode}:detach-direct-root`, () => directRoot!.detach()).catch(error =>
					log({ cleanup: "detach-direct-root", error: String(error) }),
				);
			// A timed-out screenshot can retain Puppeteer's screenshot mutex. Never reuse this browser connection or target.
			await browser?.disconnect().catch(error => log({ cleanup: "disconnect", error: String(error) }));
			transport?.close();
			if (targetId && creator)
				await creator
					.send("Target.closeTarget", { targetId })
					.catch(error => log({ cleanup: "close-target", error: String(error) }));
			creator?.close();
		}
	}
	await checkMinimized("after-all-scenarios");
	foregroundAfter = await foregroundSnapshot("after-owned-targets");
	if (foregroundBefore.available && foregroundAfter.available) {
		assert.equal(foregroundAfter.handle, foregroundBefore.handle, "OS foreground window changed");
		assert.equal(foregroundAfter.processId, foregroundBefore.processId, "OS foreground process changed");
	}
	if (results.some(result => result.gating && result.status !== "pass"))
		failure = "One or more minimized screenshot scenarios failed; inspect per-method diagnostics";
} catch (error) {
	failure = String(error);
	log({ failure });
} finally {
	if (observer)
		await step("close-isolated-browser", () => observer!.close()).catch(error => log({ cleanup: String(error) }));
	relay?.stop();
	if (profile)
		await fs
			.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
			.catch(error => log({ cleanup: String(error) }));
	await fs.mkdir(reportDir, { recursive: true });
	await Bun.write(
		path.join(reportDir, "minimized-report.json"),
		JSON.stringify(
			{
				diagnosticEnableNewSurface: process.env.OMP_E2E_ENABLE_NEW_SURFACE === "true",
				startedAt,
				sourceSha: process.env.GITHUB_SHA ?? process.env.OMP_E2E_SOURCE_SHA ?? "unknown",
				finishedAt: new Date().toISOString(),
				platform: process.platform,
				headed: true,
				diagnosticLaunchArgs: enableNewSurfaceDiagnostic ? ["--enable-features=CDPScreenshotNewSurface"] : [],
				version,
				capability:
					"Isolated headed Chrome for Testing; chrome.windows states measured. OS foreground handles are checked only when Win32 reports an interactive foreground window; unavailable snapshots are not passes. Full CLI/model session and user desktop UI are not measured. No restore/focus call is made after minimizing.",
				failure,
				results,
				directBrowserDiagnostic:
					"raw-direct-browser bypasses the extension rendering guard; underlying Chrome timeout is expected and is not a supported product capture path. All eight relay modes gate success.",
				diagnostics,
			},
			null,
			2,
		),
	);
}
if (failure) process.exitCode = 1;
