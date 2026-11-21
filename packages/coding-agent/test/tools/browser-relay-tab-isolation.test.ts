import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	closeLaunchedBrowser,
	ensureChromiumExecutable,
	RENDERER_PRIORITY_ARGS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { unpackedExtensionId } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { FOREIGN_FRAME_REFUSAL } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { getPuppeteerDir, withTimeout } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser, type CDPSession, type Page, type Protocol } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

interface TestWorker {
	outcome: Promise<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>;
	close(): Promise<void>;
}

function startWorker(payload: WorkerInitPayload): TestWorker {
	const outcome = Promise.withResolvers<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>();
	const closed = Promise.withResolvers<void>();
	let receive!: (message: WorkerInbound | WorkerOutbound) => void;
	new WorkerCore(
		{
			send(message) {
				if (message.type === "ready" || message.type === "init-failed") outcome.resolve(message);
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {
				closed.resolve();
			},
		},
		false,
	);
	receive({ type: "init", payload });
	return {
		outcome: outcome.promise,
		async close() {
			receive({ type: "close" });
			await closed.promise;
		},
	};
}

/** Order real Chrome detach and one explicit synthetic notice only for the disposable recovery fixture. */
function recoveryFixtureDebuggerHook(origin: string): string {
	return `
let testMenuRecoveryDetachedId;
const testMenuRecoveryUrl = ${JSON.stringify(origin + "/login?who=driven")};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (message.op !== "testParkMenuRecoveryDebugger" && message.op !== "testReportMenuRecoveryDetach") return;
	if (sender.id !== chrome.runtime.id || !Number.isSafeInteger(message.tabId)) {
		respond({ error: "Not the disposable recovery fixture" });
		return;
	}
	(async () => {
		const tab = await chrome.tabs.get(message.tabId);
		if (tab.url !== testMenuRecoveryUrl || tab.active) throw new Error("Not the exact hidden recovery fixture tab");
		if (message.op === "testParkMenuRecoveryDebugger") {
			if (testMenuRecoveryDetachedId !== undefined) throw new Error("Already parked for fixture");
			await chrome.debugger.detach({ tabId: message.tabId });
			testMenuRecoveryDetachedId = message.tabId;
		} else {
			if (testMenuRecoveryDetachedId !== message.tabId) throw new Error("No verified detach to report for fixture");
			testMenuRecoveryDetachedId = undefined;
			// Programmatic detach does not fire onDetach. Only time the test notification;
			// real Chrome, via the unchanged callback, remains the authority on reattach.
			globalThis.testDebuggerDetach({ tabId: message.tabId }, "target_closed");
		}
		return {};
	})().then(respond, error => respond({ error: String(error) }));
	return true;
});
`;
}

interface RelayBrowser {
	browser: Browser;
	/** Chromium's observed id for each disposable extension fixture. */
	extensionIds: ReadonlyMap<string, string>;
	/** Evaluates `expression` on an extension page, where Chrome's tab and runtime APIs are in scope. */
	inExtension(expression: string): Promise<unknown>;
}

interface RelayFixture extends RelayBrowser {
	server: RelayServer;
	cdpUrl: string;
	origin: string;
	/** The folder the fixture's browsers save downloads to. */
	downloads: string;
	/** The `index`-th request for `/held.csv`, whose body ends only once the test resolves it. */
	heldDownload(index: number): Promise<PromiseWithResolvers<void>>;
	/** Another Chromium with its own profile and the same extension, as a second browser on the relay. */
	launchBrowser(): Promise<RelayBrowser>;
	close(): Promise<void>;
}

/**
 * Headless Chromium running the real relay extension, and any `extensions` beside it, against a relay on a free
 * port, plus a loopback site. A test-only message listener controls its service worker: a programmatic debugger
 * detach does not fire `onDetach`, and `testRefuseRemoves` makes that many `chrome.tabs.remove` calls reject first.
 */
async function launchRelayFixture(
	log?: (message: string, data?: Record<string, unknown>) => void,
	extensions: string[] = [],
	controlledMenuRecovery = false,
): Promise<RelayFixture> {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false, log });
	const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-"));
	// Every fixture browser saves downloads here, as the user's Chrome would its own folder (real names, " (1)" on a clash).
	const downloads = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-downloads-")));
	const profiles: string[] = [];
	const held: Array<PromiseWithResolvers<void>> = [];
	let heldArrived = Promise.withResolvers<void>();
	const pages = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const route = url.pathname;
			const attachment = (name: string) => ({
				"Content-Type": "text/csv",
				"Content-Disposition": `attachment; filename="${name}"`,
			});
			if (route === "/report.csv") return new Response("a,b\n1,2\n", { headers: attachment("report.csv") });
			if (route === "/held.csv") {
				const release = Promise.withResolvers<void>();
				held.push(release);
				heldArrived.resolve();
				heldArrived = Promise.withResolvers<void>();
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("a,b\n"));
						await release.promise;
						controller.enqueue(new TextEncoder().encode("1,2\n"));
						controller.close();
					},
				});
				return new Response(body, { headers: attachment("held.csv") });
			}
			const html =
				route === "/first"
					? `<title>First</title><button onclick="this.textContent='clicked'">First</button><p id="hover" onmouseover="this.textContent='hovered'">Hover</p>`
					: route === "/second"
						? "<title>Second</title><button>Second</button>"
						: route === "/login"
							? `<title>Login ${url.searchParams.get("who")}</title><form onsubmit="event.preventDefault(); document.title = 'Signed in'"><input id="pw" type="password"><button id="go">Log in</button></form>`
							: route === "/download"
								? `<title>Download</title><a id="report" href="/report.csv">Report</a><a id="held" href="/held.csv">Held</a>`
								: route === "/framed"
									? // Another site (localhost, not 127.0.0.1), so Chrome runs the frame in its own process and session.
										`<title>Framed</title><iframe src="http://localhost:${url.port}/download"></iframe>`
									: "<title>Human sentinel</title><h1>Keep me</h1>";
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		},
	});
	const browsers: Browser[] = [];
	async function close() {
		// A failed test may leave a held download open; end it so the browser and server can stop.
		for (const release of held) release.resolve();
		try {
			await Promise.all(browsers.map(browser => closeLaunchedBrowser({ browser })));
		} finally {
			server.stop();
			pages.stop(true);
			await fs.rm(extensionDir, { recursive: true, force: true });
			await fs.rm(downloads, { recursive: true, force: true });
			for (const profile of profiles) await fs.rm(profile, { recursive: true, force: true });
		}
	}
	async function launchBrowser(): Promise<RelayBrowser> {
		const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-profile-"));
		profiles.push(userDataDir);
		await Bun.write(
			path.join(userDataDir, "Default", "Preferences"),
			JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
		);
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			userDataDir,
			enableExtensions: true,
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain", ...RENDERER_PRIORITY_ARGS],
		});
		browsers.push(browser);
		// Puppeteer's `enableExtensions` list does not wait for its installs, so a page could load before a stand-in
		// vault's content script is registered.
		const extensionIds = new Map<string, string>();
		for (const extension of [extensionDir, ...extensions]) {
			extensionIds.set(extension, await browser.installExtension(extension));
		}
		const extensionId = await unpackedExtensionId(extensionDir);
		if (!extensionId) throw new Error("Missing relay extension directory");
		// A service worker is transient: it may start and stop before Puppeteer observes its target.
		// An extension page can wake it via runtime messaging and remains available for tab queries.
		const page = await browser.newPage();
		// Chrome registers an unpacked extension asynchronously after `Extensions.loadUnpacked`
		// returns; until then its pages fail with ERR_BLOCKED_BY_CLIENT. No CDP event marks
		// registration (the service worker target is transient), so poll the real browser.
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				await page.goto(`chrome-extension://${extensionId}/options.html`);
				break;
			} catch (error) {
				if (!String(error).includes("ERR_BLOCKED_BY_CLIENT") || Date.now() > deadline) throw error;
				await Bun.sleep(50);
			}
		}
		// Puppeteer's `page.evaluate` lands in a context without the extension APIs; the page's
		// default context, which `Runtime.evaluate` targets, has them.
		const cdp = await page.createCDPSession();
		async function inExtension(expression: string): Promise<unknown> {
			const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
			});
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		}
		return { browser, extensionIds, inExtension };
	}
	try {
		for (const file of ["manifest.json", "options.html", "options.js"]) {
			await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(extensionDir, file));
		}
		const background = await fs.readFile(path.join(ASSETS, "background.js.txt"), "utf8");
		const defaultPort = "var DEFAULT_PORT = 9224;";
		if (!background.includes(defaultPort)) throw new Error("Relay extension default port not found");
		// Point the disposable extension at this relay without deferring listener registration.
		await fs.writeFile(
			path.join(extensionDir, "background.js"),
			`const testRegisterDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
chrome.debugger.onDetach.addListener = listener => {
	globalThis.testDebuggerDetach = listener;
	testRegisterDetach(listener);
};
const testRemoveTab = chrome.tabs.remove.bind(chrome.tabs);
chrome.tabs.remove = tabId => {
	if (globalThis.testRefuseRemoves > 0) {
		globalThis.testRefuseRemoves--;
		return Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab)."));
	}
	return testRemoveTab(tabId);
};
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message.op === "refuseRemoves") {
		globalThis.testRefuseRemoves = message.count;
		respond({});
	} else if (message.op === "dismissDebugger") {
		chrome.debugger.detach({ tabId: message.tabId }).then(() => {
			globalThis.testDebuggerDetach({ tabId: message.tabId }, "canceled_by_user");
			respond({});
		}, error => respond({ error: String(error) }));
		return true;
	}
});
${controlledMenuRecovery ? recoveryFixtureDebuggerHook(`http://127.0.0.1:${pages.port}`) : ""}${background.replace(defaultPort, `var DEFAULT_PORT = ${port};`)}`,
		);
		const { browser, extensionIds, inExtension } = await launchBrowser();
		const cdpUrl = `http://127.0.0.1:${port}`;
		// Finish the extension hello before the native CDP client attaches to the sentinel.
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return {
			browser,
			extensionIds,
			inExtension,
			server,
			cdpUrl,
			origin: `http://127.0.0.1:${pages.port}`,
			downloads,
			async heldDownload(index) {
				while (held.length <= index) await heldArrived.promise;
				return held[index]!;
			},
			launchBrowser,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

function chromeTabId(targetId: string): number {
	return Number(targetId.slice(targetId.lastIndexOf(".") + 1));
}

/** Chrome's own view of a tab (`{ active }`), or null once it is closed. */
async function chromeTab(fixture: RelayFixture, tabId: number): Promise<unknown> {
	return await fixture.inExtension(
		`chrome.tabs.query({}).then(tabs => { const tab = tabs.find(tab => tab.id === ${tabId}); return tab ? { active: tab.active } : null; })`,
	);
}

async function activeChromeTabUrl(fixture: RelayFixture): Promise<unknown> {
	return await fixture.inExtension(
		"chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0]?.url)",
	);
}

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

/**
 * A stand-in password manager running `contentScript` on the fixture site, which may draw its `menu.html` and
 * `notification.html` into the page as chrome-extension:// frames.
 */
async function writeStandInVault(contentScript: string): Promise<string> {
	const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-vault-"));
	await fs.writeFile(
		path.join(vaultDir, "manifest.json"),
		JSON.stringify({
			manifest_version: 3,
			name: "Stand-in vault",
			version: "1.0",
			content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
			web_accessible_resources: [{ resources: ["menu.html", "notification.html"], matches: ["http://127.0.0.1/*"] }],
		}),
	);
	await fs.writeFile(path.join(vaultDir, "menu.html"), '<button>Fill</button><script defer src="menu.js"></script>');
	// The real extension document (not the frame owner or load event) proves it is alive.
	// menu.js is an extension-local resource and is not exposed to web pages in the manifest.
	await fs.writeFile(
		path.join(vaultDir, "menu.js"),
		`const documentId = crypto.randomUUID();
window.addEventListener("message", event => {
	if (event.source !== window.parent || !event.origin.startsWith("http://127.0.0.1:")) return;
	const request = event.data;
	if (request?.type !== "omp-fixture-menu-probe" || typeof request.challenge !== "string") return;
	if (document.querySelector("button")?.textContent !== "Fill") return;
	window.parent.postMessage({
		type: "omp-fixture-menu-reply",
		challenge: request.challenge,
		documentId,
		url: window.location.href,
	}, event.origin);
});`,
	);
	await fs.writeFile(
		path.join(vaultDir, "notification.html"),
		"<title>Vault: save login</title><h3>Save login?</h3><button>Save</button>",
	);
	// A page the vault does not expose to sites, so no site can frame it.
	await fs.writeFile(path.join(vaultDir, "private.html"), "<title>Vault private</title>");
	await fs.writeFile(path.join(vaultDir, "content.js"), contentScript);
	return vaultDir;
}

/** Match the actual fixture iframe owner, including inside a closed shadow root. */
function fixtureFrameNode(
	root: Protocol.DOM.Node,
	extensionUrl: string,
	closedShadowHost?: string,
): Protocol.DOM.Node | undefined {
	const queue = [root];
	for (const node of queue) {
		if (closedShadowHost && node.nodeName === closedShadowHost) {
			const shadow = node.shadowRoots?.find(root => root.shadowRootType === "closed");
			const frame = shadow && fixtureFrameNode(shadow, extensionUrl);
			if (frame) return frame;
		}
		if (
			!closedShadowHost &&
			node.nodeName === "IFRAME" &&
			node.attributes?.some((attr, i, attrs) => i % 2 === 0 && attr === "src" && attrs[i + 1] === extensionUrl)
		)
			return node;
		queue.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
	}
	return undefined;
}

/** Read only fixture-owned frame attributes, including the host's closed shadow root. */
async function frameAttributes(page: Page, extensionUrl: string): Promise<string[]> {
	const cdp = await page.createCDPSession();
	try {
		const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
		const attrs = fixtureFrameNode(root, extensionUrl)?.attributes;
		if (!attrs?.length) throw new Error("Fixture extension frame is missing");
		return attrs;
	} finally {
		await cdp.detach();
	}
}

interface FixtureMenuObservation {
	attributes: string[];
	backendNodeId: Protocol.DOM.BackendNodeId;
	frameId: Protocol.Page.FrameId;
	documentId: string;
}

interface FixtureMenuProgress {
	ready: boolean;
	mount: string | null;
	loads: string | null;
	reply: string | null;
	visibility: string;
}

/** A detach failure is reported only when it would not mask the original inspection error. */
async function withFixtureObserver<T>(cdp: CDPSession, read: (cdp: CDPSession) => Promise<T>): Promise<T> {
	let failed = false;
	try {
		return await read(cdp);
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		if (!cdp.detached) {
			if (failed) await cdp.detach().catch(() => undefined);
			else await cdp.detach();
		}
	}
}

/** Challenge the exact live fixture document, then snapshot its closed-shadow iframe through native CDP. */
async function observeFixtureMenu(page: Page, url: string, phase: string): Promise<FixtureMenuObservation> {
	return await withFixtureObserver(await page.createCDPSession(), async cdp => {
		const deadline = performance.now() + 7_500;
		const options = () => ({ timeout: Math.max(1, Math.ceil(deadline - performance.now())) });
		const challenge = crypto.randomUUID();
		const prefix = challenge + ":";
		const read = `(() => {
	const host = document.querySelector("vault-menu");
	return {
		ready: document.documentElement.hasAttribute("data-omp-fixture-menu-ready"),
		mount: host?.getAttribute("data-omp-fixture-menu-mount") ?? null,
		loads: host?.getAttribute("data-omp-fixture-menu-loads") ?? null,
		reply: host?.getAttribute("data-omp-fixture-menu-reply") ?? null,
		visibility: document.visibilityState,
	};
})()`;
		let progress: FixtureMenuProgress | undefined;
		const diagnostics = () =>
			`ready=${progress?.ready ?? false}; mount=${progress?.mount ?? "absent"}; ` +
			`loads=${progress?.loads ?? "0"}; replied=${Boolean(progress?.reply)}; visibility=${progress?.visibility ?? "unknown"}`;
		try {
			const probe = `document.dispatchEvent(new CustomEvent("omp-fixture-probe-menu", { detail: ${JSON.stringify(challenge)} }));`;
			while (performance.now() < deadline) {
				const { result, exceptionDetails } = await cdp.send(
					"Runtime.evaluate",
					{ expression: probe + read, returnByValue: true },
					options(),
				);
				if (exceptionDetails) throw new Error(exceptionDetails.text);
				progress = result.value as FixtureMenuProgress | undefined;
				const documentId = progress?.reply?.startsWith(prefix) && progress.reply.slice(prefix.length);
				if (documentId) {
					const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, options());
					const node = fixtureFrameNode(root, url, "VAULT-MENU");
					if (!node?.frameId || !node.attributes?.length) {
						throw new Error("Reply received, but the fixture iframe owner is missing");
					}
					return {
						attributes: node.attributes,
						backendNodeId: node.backendNodeId,
						frameId: node.frameId,
						documentId,
					};
				}
				// A probe sent before the genuine menu initializes can be dropped. Reuse one challenge.
				await Bun.sleep(Math.min(25, options().timeout));
			}
		} catch (cause) {
			throw new Error(`Fixture menu observation failed (${phase}; ${diagnostics()})`, { cause });
		}
		throw new Error(`Fixture menu document did not answer (${phase}; ${diagnostics()})`);
	});
}

const standInMenuScript = `const menuUrl = chrome.runtime.getURL("menu.html");
const menuOrigin = "chrome-extension://" + chrome.runtime.id;
let menu;
let host;
let challenge;
function probeMenu() {
	if (!challenge || !menu?.isConnected) return;
	menu.contentWindow?.postMessage({ type: "omp-fixture-menu-probe", challenge }, menuOrigin);
}
window.addEventListener("message", event => {
	const reply = event.data;
	if (!challenge || !menu?.isConnected || event.source !== menu.contentWindow || event.origin !== menuOrigin) return;
	if (reply?.type !== "omp-fixture-menu-reply" || reply.challenge !== challenge ||
		reply.url !== menuUrl || typeof reply.documentId !== "string" || !reply.documentId) return;
	host.setAttribute("data-omp-fixture-menu-reply", challenge + ":" + reply.documentId);
});
document.addEventListener("omp-fixture-probe-menu", event => {
	if (!host || typeof event.detail !== "string") return;
	if (challenge !== event.detail) {
		challenge = event.detail;
		host.removeAttribute("data-omp-fixture-menu-reply");
	}
	probeMenu();
});
document.addEventListener("omp-fixture-show-menu", () => {
	if (host) return;
	host = document.createElement("vault-menu");
	menu = document.createElement("iframe");
	let loads = 0;
	menu.addEventListener("load", () => {
		host.setAttribute("data-omp-fixture-menu-loads", String(++loads));
		probeMenu();
	});
	// Set src while detached so insertion does not schedule an about:blank load first.
	menu.src = menuUrl;
	host.attachShadow({ mode: "closed" }).append(menu);
	document.body.append(host);
	host.setAttribute("data-omp-fixture-menu-mount", "src-assigned");
});
document.documentElement.setAttribute("data-omp-fixture-menu-ready", "");`;

async function showStandInMenu(page: Page, menu: string, phase: string): Promise<FixtureMenuObservation> {
	try {
		await page.waitForFunction("document.documentElement.hasAttribute('data-omp-fixture-menu-ready')", {
			polling: 25,
			timeout: 5_000,
		});
	} catch (cause) {
		throw new Error(`Fixture menu content script did not become ready (${phase})`, { cause });
	}
	const mounted = await page.evaluate(`(() => {
	document.dispatchEvent(new Event("omp-fixture-show-menu"));
	return !!document.querySelector("vault-menu");
})()`);
	if (!mounted) throw new Error(`Fixture menu trigger did not mount its host (${phase})`);
	return await observeFixtureMenu(page, menu, phase);
}

const standInMenuDismissal = `
document.addEventListener("omp-fixture-show-menu", () => {
	if (document.getElementById("omp-fixture-dismiss-menu")) return;
	const button = document.createElement("button");
	button.id = "omp-fixture-dismiss-menu";
	button.type = "button";
	button.textContent = "Dismiss fixture menu";
	button.addEventListener("click", () => {
		host.remove();
		menu = undefined;
		host = undefined;
		button.remove();
	}, { once: true });
	document.body.append(button);
});`;

async function markRecoveryFixtureDocument(page: Page): Promise<string> {
	const id = crypto.randomUUID();
	await page.evaluate(`document.documentElement.setAttribute("data-omp-fixture-document-id", ${JSON.stringify(id)})`);
	return id;
}

async function nativeRecoveryDocument(page: Page): Promise<unknown> {
	return await page.evaluate('document.documentElement.getAttribute("data-omp-fixture-document-id")');
}

async function readRecoveryFixtureDocument(name: string): Promise<unknown> {
	const result = await runInTab(name, {
		code: `return {
	title: await tab.title(),
	url: await tab.url(),
	documentId: await tab.evaluate(() => document.documentElement.getAttribute("data-omp-fixture-document-id")),
};`,
		timeoutMs: 10_000,
		session,
	});
	return result.returnValue;
}

async function dismissRecoveryFixtureMenu(page: Page, frameId: Protocol.Page.FrameId): Promise<void> {
	const client = page.mainFrame().client;
	const removed = Promise.withResolvers<void>();
	const observe = (event: Protocol.Page.FrameDetachedEvent) => {
		if (event.frameId === frameId && event.reason === "remove") removed.resolve();
	};
	client.on("Page.frameDetached", observe);
	try {
		const dismissed = await page.evaluate(`(() => {
			const button = document.getElementById("omp-fixture-dismiss-menu");
			if (!button || button.tagName !== "BUTTON") return false;
			button.click();
			return !document.querySelector("vault-menu") && !button.isConnected;
		})()`);
		expect(dismissed).toBeTrue();
		await withTimeout(removed.promise, 5_000, "Native Chrome did not report removal of the exact fixture menu frame");
	} finally {
		client.off("Page.frameDetached", observe);
	}
}

/** Chrome itself can refuse an attach; neither a refusal nor a success may report a mutation. */
async function checkTitleWithoutHidingFrame(name: string, title: string): Promise<void> {
	let result;
	try {
		result = await runInTab(name, {
			code: "return await tab.title();",
			timeoutMs: 10_000,
			session,
		});
	} catch (error) {
		const text = String(error);
		expect(text).toMatch(/another extension.s frame|Cannot access a chrome-extension:\/\//i);
		expect(text).not.toContain("after omp cleared it");
		return;
	}
	expect(result.returnValue).toBe(title);
	expect(result.displays).toEqual([]);
}

/** Observe a completed download independently; no relay or worker API grants a host path. */
async function waitForFixtureDownload(filename: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	for (;;) {
		try {
			if ((await Bun.file(filename).text()) === "a,b\n1,2\n") return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (performance.now() >= deadline) throw new Error("Fixture download did not complete");
		await Bun.sleep(25);
	}
}

async function expectRelayDownloadTrackingRejected(name: string): Promise<void> {
	for (const code of ["return await tab.waitForDownload({ timeout: 1000 });", "return await tab.downloads();"]) {
		const error = await rejectionOf(runInTab(name, { code, timeoutMs: 10_000, session }));
		expect(error).toMatchObject({
			message: "Download tracking is not supported through the browser relay",
		});
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab ownership", () => {
	it("keeps another connection's cross-site frame alive when a page disables auto-attach", async () => {
		const fixture = await launchRelayFixture();
		let first: Browser | undefined;
		let second: Browser | undefined;
		try {
			const source = await fixture.browser.newPage();
			await source.goto(`${fixture.origin}/framed`);
			first = await puppeteer.connect({ browserURL: fixture.cdpUrl });
			second = await puppeteer.connect({ browserURL: fixture.cdpUrl });
			const firstPage = (await first.pages()).find(page => page.url() === source.url())!;
			const secondPage = (await second.pages()).find(page => page.url() === source.url())!;
			const frame = secondPage.frames().find(frame => frame.parentFrame())!;
			expect(
				await frame.client.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
			).toMatchObject({
				result: { value: "Download" },
			});
			const detached: string[] = [];
			secondPage.mainFrame().client.on("Target.detachedFromTarget", event => detached.push(event.sessionId));

			await firstPage.mainFrame().client.send("Target.setAutoAttach", {
				autoAttach: false,
				waitForDebuggerOnStart: false,
				flatten: true,
			});
			// A command on the surviving child proves Chrome did not tear down its shared session.
			expect(
				await frame.client.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
			).toMatchObject({
				result: { value: "Download" },
			});
			expect(detached).toEqual([]);
		} finally {
			await first?.disconnect();
			await second?.disconnect();
			await fixture.close();
		}
	});

	it("opens default relay tabs in the background and closes them, leaving borrowed pages open", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [`relay-first-${process.pid}`, `relay-second-${process.pid}`, `relay-borrowed-${process.pid}`];
		try {
			const first = await acquireTab(names[0]!, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			// An open that adopted the selected tab would have navigated it to the `url`.
			expect(human.url()).toBe(humanUrl);
			const second = await acquireTab(names[1]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(first.tab.targetId).not.toBe(second.tab.targetId);
			expect(human.url()).toBe(humanUrl);
			expect(await human.title()).toBe("Human sentinel");
			// The user's tab stays selected; the owned tabs were created unselected.
			expect(await activeChromeTabUrl(fixture)).toBe(humanUrl);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toEqual({ active: false });

			const clicked = await runInTab(names[0]!, {
				code: "await tab.click('button'); return await tab.text('button');",
				timeoutMs: 10_000,
				session,
			});
			expect(clicked.returnValue).toBe("clicked");
			// Hover waits for a rendered frame, which a hidden tab never produces: this passes only while the
			// unselected tab is focus-emulated.
			const hovered = await runInTab(names[0]!, {
				code: "await tab.hover('#hover'); return await tab.text('#hover');",
				timeoutMs: 10_000,
				session,
			});
			expect(hovered.returnValue).toBe("hovered");
			// A screenshot of the unselected tab is captured in place: it never selects the tab.
			const shot = await runInTab(names[0]!, {
				code: "return typeof (await tab.screenshot());",
				timeoutMs: 10_000,
				session,
			});
			expect(shot.returnValue).toBe("string");
			expect(await activeChromeTabUrl(fixture)).toBe(humanUrl);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toEqual({ active: false });

			await releaseTab(names[0]!);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toBeNull();
			expect(await human.title()).toBe("Human sentinel");
			const surviving = await runInTab(names[1]!, { code: "return await tab.title();", timeoutMs: 10_000, session });
			expect(surviving.returnValue).toBe("Second");

			// `target` borrows the user's page; closing releases it without closing it.
			const borrowed = await acquireTab(names[2]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			expect(borrowed.tab.targetId).not.toBe(first.tab.targetId);
			await releaseTab(names[2]!);
			expect(human.isClosed()).toBeFalse();
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("opens a default tab in the browser of the tab omp used last, not the first selected one", async () => {
		const secondHello = Promise.withResolvers<void>();
		let hellos = 0;
		const fixture = await launchRelayFixture(message => {
			if (message === "extension connected" && ++hellos === 2) secondHello.resolve();
		});
		// The first browser shows the first selected tab, which a new tab would otherwise follow.
		const human = await fixture.browser.newPage();
		await human.goto(`${fixture.origin}/human`);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [
			`relay-near-human-${process.pid}`,
			`relay-near-other-${process.pid}`,
			`relay-near-own-${process.pid}`,
		];
		/** The browser a relay target id belongs to (`PAGE<browser>.<tab>`). */
		const browserOf = (targetId: string) => targetId.slice(4, targetId.lastIndexOf("."));
		try {
			// Borrowing waits until the relay lists the tab, so the first browser's selected tab is listed first.
			const inFirst = await acquireTab(names[0]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			const other = await fixture.launchBrowser();
			// The relay announces a browser's tabs to connected clients only as they change after its hello.
			await secondHello.promise;
			await (await other.browser.newPage()).goto(`${fixture.origin}/first`);
			const inSecond = await acquireTab(names[1]!, relay, { target: "First", timeoutMs: 15_000 });
			expect(browserOf(inSecond.tab.targetId)).not.toBe(browserOf(inFirst.tab.targetId));
			const owned = await acquireTab(names[2]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(browserOf(owned.tab.targetId)).toBe(browserOf(inSecond.tab.targetId));
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes an owned tab Chrome refuses to close at first", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-refused-close-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
			});
			// The extension retries twice, so the worker's close claim must outlive the full retry window.
			await fixture.inExtension('chrome.runtime.sendMessage({ op: "refuseRemoves", count: 2 })');
			await releaseTab(name);
			// The close returned with the tab gone.
			expect(await chromeTab(fixture, chromeTabId(tab.targetId))).toBeNull();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("leaves a persist tab open in the user's browser when its session ends and closes the others", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const owner = `relay-session-${process.pid}`;
		const names = [`relay-persist-${process.pid}`, `relay-plain-${process.pid}`];
		try {
			const kept = await acquireTab(names[0]!, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
				persist: true,
			});
			const closed = await acquireTab(names[1]!, relay, {
				url: `${fixture.origin}/second`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
			});
			// What session dispose runs.
			expect(await releaseTabsForOwner(owner, { kill: true })).toBe(2);
			const keptTabId = chromeTabId(kept.tab.targetId);
			expect(await fixture.inExtension(`chrome.tabs.get(${keptTabId}).then(tab => tab.url)`)).toBe(
				`${fixture.origin}/first`,
			);
			expect(await chromeTab(fixture, chromeTabId(closed.tab.targetId))).toBeNull();
			expect(getTabsMapForTest().has(names[0]!)).toBeFalse();
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes a persist tab whose close joins its session's end", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const owner = `relay-joined-session-${process.pid}`;
		const name = `relay-joined-close-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
				persist: true,
			});
			const ending = releaseTabsForOwner(owner, { kill: true });
			expect(await releaseTab(name)).toBe(true);
			await ending;
			expect(await chromeTab(fixture, chromeTabId(tab.targetId))).toBeNull();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes a persist tab when its close joins after the keep decision and browser disconnect", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		if (!("browser" in relay)) throw new Error("Expected relay Chromium");
		const owner = `relay-late-session-${process.pid}`;
		const name = `relay-late-close-${process.pid}`;
		const disconnect = relay.browser.disconnect.bind(relay.browser);
		let closing: Promise<boolean> | undefined;
		try {
			const { tab } = await acquireTab(name, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
				persist: true,
			});
			// releaseBrowser disconnects only after the supervisor has decided to keep the page.
			relay.browser.disconnect = () => {
				const disconnected = disconnect();
				closing = releaseTab(name);
				return disconnected;
			};
			await releaseTabsForOwner(owner, { kill: true });
			expect(closing).toBeDefined();
			expect(await closing).toBe(true);
			expect(await chromeTab(fixture, chromeTabId(tab.targetId))).toBeNull();
		} finally {
			relay.browser.disconnect = disconnect;
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("does not change either fixture extension menu when the relay borrows a tab", async () => {
		const vaultDir = await writeStandInVault(standInMenuScript);
		let fixture: RelayFixture | undefined;
		let relay: BrowserHandle | undefined;
		const name = `relay-vault-${process.pid}`;
		try {
			fixture = await launchRelayFixture(undefined, [vaultDir]);
			const vaultId = fixture.extensionIds.get(vaultDir);
			if (!vaultId) throw new Error("Chromium did not report the stand-in vault installation");
			const menu = `chrome-extension://${vaultId}/menu.html`;
			const driven = await fixture.browser.newPage();
			await driven.goto(`${fixture.origin}/login?who=driven`);
			const user = await fixture.browser.newPage();
			const userUrl = `${fixture.origin}/login?who=user`;
			await user.goto(userUrl);
			// The user's menu is already open when omp first connects. Never activate the driven tab.
			await user.bringToFront();
			const userMenu = await showStandInMenu(user, menu, "user tab before registry connection");
			relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
			expect(await observeFixtureMenu(user, menu, "user tab after registry connection")).toEqual(userMenu);
			expect(await activeChromeTabUrl(fixture)).toBe(userUrl);
			const { tab } = await acquireTab(name, relay, { target: "Login driven", timeoutMs: 20_000 });
			if (tab.backend !== "worker") throw new Error("Expected a real relay tab worker");
			expect(tab.ownsPage).toBeFalse();
			expect(await chromeTab(fixture, chromeTabId(tab.targetId))).toEqual({ active: false });
			expect(await activeChromeTabUrl(fixture)).toBe(userUrl);
			expect(await driven.evaluate(() => document.visibilityState)).toBe("hidden");
			// Trigger the real fixture UI only after borrow, through the independent Chrome connection.
			const drivenMenu = await showStandInMenu(driven, menu, "driven tab after borrow");
			expect(drivenMenu.documentId).not.toBe(userMenu.documentId);
			await checkTitleWithoutHidingFrame(name, "Login driven");
			expect(await observeFixtureMenu(driven, menu, "driven tab after relay read")).toEqual(drivenMenu);
			expect(await observeFixtureMenu(user, menu, "user tab after relay read")).toEqual(userMenu);
			expect(drivenMenu.attributes).not.toContain("srcdoc");
			expect(userMenu.attributes).not.toContain("srcdoc");
			expect(await activeChromeTabUrl(fixture)).toBe(userUrl);
			expect(await driven.evaluate(() => document.visibilityState)).toBe("hidden");
			await releaseTab(name);
			expect(driven.isClosed()).toBeFalse();
			expect(user.isClosed()).toBeFalse();
		} finally {
			try {
				if (relay) {
					await releaseTab(name).catch(() => undefined);
					await releaseBrowser(relay, { kill: false });
				}
			} finally {
				try {
					await fixture?.close();
				} finally {
					await fs.rm(vaultDir, { recursive: true, force: true });
				}
			}
		}
	}, 60_000);

	it("reads the ordinary same borrowed target without reload or focus when Chrome never refused it", async () => {
		const fixture = await launchRelayFixture();
		let relay: BrowserHandle | undefined;
		const name = `relay-menu-recovery-control-${process.pid}`;
		try {
			const driven = await fixture.browser.newPage();
			await driven.goto(`${fixture.origin}/login?who=driven`);
			const user = await fixture.browser.newPage();
			await user.goto(`${fixture.origin}/login?who=user`);
			await user.bringToFront();
			const documentId = await markRecoveryFixtureDocument(driven);
			const userDocumentId = await markRecoveryFixtureDocument(user);
			const userUrl = user.url();
			const url = driven.url();

			relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
			const { tab } = await acquireTab(name, relay, { target: "Login driven", timeoutMs: 20_000 });
			if (tab.backend !== "worker") throw new Error("Expected a real relay tab worker");
			expect(tab.ownsPage).toBeFalse();
			const targetId = tab.targetId;
			expect(await readRecoveryFixtureDocument(name)).toEqual({ title: "Login driven", url, documentId });
			expect(await readRecoveryFixtureDocument(name)).toEqual({ title: "Login driven", url, documentId });
			expect(getTabsMapForTest().get(name)).toBe(tab);
			expect(tab.targetId).toBe(targetId);
			expect(await activeChromeTabUrl(fixture)).toBe(userUrl);
			expect(await driven.evaluate(() => document.visibilityState)).toBe("hidden");
			expect(await nativeRecoveryDocument(user)).toBe(userDocumentId);
			expect(user.url()).toBe(userUrl);
			await releaseTab(name);
			expect(driven.isClosed()).toBeFalse();
			expect(user.isClosed()).toBeFalse();
		} finally {
			try {
				if (relay) {
					await releaseTab(name).catch(() => undefined);
					await releaseBrowser(relay, { kill: false });
				}
			} finally {
				await fixture.close();
			}
		}
	}, 60_000);

	it("recovers the same borrowed tab after a synthetic detach notice, stock Chrome refusal, and native fixture menu dismissal", async () => {
		const vaultDir = await writeStandInVault(standInMenuScript + standInMenuDismissal);
		const name = `relay-menu-recovery-${process.pid}`;
		const failedAttach = Promise.withResolvers<string>();
		let expectedTabId: number | undefined;
		let fixture: RelayFixture | undefined;
		let relay: BrowserHandle | undefined;
		try {
			fixture = await launchRelayFixture(
				(message, data) => {
					if (
						expectedTabId !== undefined &&
						message === "attach failed" &&
						typeof data?.tabKey === "string" &&
						data.tabKey.endsWith(`:${expectedTabId}`) &&
						typeof data.error === "string" &&
						FOREIGN_FRAME_REFUSAL.test(data.error)
					) {
						failedAttach.resolve(data.error);
					}
				},
				[vaultDir],
				true,
			);
			const vaultId = fixture.extensionIds.get(vaultDir);
			if (!vaultId) throw new Error("Chromium did not report the stand-in vault installation");
			const menu = `chrome-extension://${vaultId}/menu.html`;
			const driven = await fixture.browser.newPage();
			await driven.goto(`${fixture.origin}/login?who=driven`);
			const user = await fixture.browser.newPage();
			await user.goto(`${fixture.origin}/login?who=user`);
			await user.bringToFront();
			const documentId = await markRecoveryFixtureDocument(driven);
			const userDocumentId = await markRecoveryFixtureDocument(user);
			const userUrl = user.url();
			const url = driven.url();
			const expected = { title: "Login driven", url, documentId };

			relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
			const { tab } = await acquireTab(name, relay, { target: "Login driven", timeoutMs: 20_000 });
			if (tab.backend !== "worker") throw new Error("Expected a real relay tab worker");
			expect(tab.ownsPage).toBeFalse();
			const targetId = tab.targetId;
			expectedTabId = chromeTabId(targetId);
			expect(await readRecoveryFixtureDocument(name)).toEqual(expected);
			expect(await activeChromeTabUrl(fixture)).toBe(userUrl);

			// Order the natural browser guard deterministically: genuinely detach Chrome, then let
			// the independent fixture mount and verify its real extension document before notifying
			// omp. The subsequent attach result comes only from stock Chrome, not from this fixture.
			expect(
				await fixture.inExtension(
					`chrome.runtime.sendMessage({ op: "testParkMenuRecoveryDebugger", tabId: ${expectedTabId} })`,
				),
			).toEqual({});
			const menuBefore = await showStandInMenu(driven, menu, "driven tab while its real debugger is detached");
			expect(
				await fixture.inExtension(
					`chrome.runtime.sendMessage({ op: "testReportMenuRecoveryDetach", tabId: ${expectedTabId} })`,
				),
			).toEqual({});
			await withTimeout(failedAttach.promise, 7_500, "Stock Chrome never refused the exact borrowed tab's reattach");
			const denied = await rejectionOf(readRecoveryFixtureDocument(name));
			expect(String(denied)).toMatch(/omp kept the tab open as it is/);
			expect(getTabsMapForTest().get(name)).toBe(tab);
			expect(tab.targetId).toBe(targetId);
			expect(tab.heldOut).toBeTrue();
			expect(await observeFixtureMenu(driven, menu, "driven menu after the real refusal")).toEqual(menuBefore);

			// The exact test-owned UI on the independent native connection dismisses its own menu.
			// Require the frame-removal event, not only the style/host change or a guessed delay.
			await dismissRecoveryFixtureMenu(driven, menuBefore.frameId);
			expect(await nativeRecoveryDocument(driven)).toBe(documentId);
			expect(driven.url()).toBe(url);
			expect(await activeChromeTabUrl(fixture)).toBe(userUrl);
			expect(await driven.evaluate(() => document.visibilityState)).toBe("hidden");
			expect(await nativeRecoveryDocument(user)).toBe(userDocumentId);
			expect(user.url()).toBe(userUrl);

			let failedRead: Error | undefined;
			try {
				// This is a normal, single same-name operation. No release/reopen, navigation,
				// changed URL or force-attach; the previous denial is not a success here.
				expect(await readRecoveryFixtureDocument(name)).toEqual(expected);
			} catch (cause) {
				failedRead = new Error("The fixture menu is gone, but the ordinary same-page relay read did not recover", {
					cause,
				});
			} finally {
				expect(getTabsMapForTest().get(name)).toBe(tab);
				expect(tab.targetId).toBe(targetId);
				expect(driven.url()).toBe(url);
				expect(await nativeRecoveryDocument(driven)).toBe(documentId);
				expect(await chromeTab(fixture, expectedTabId)).toEqual({ active: false });
				expect(await activeChromeTabUrl(fixture)).toBe(userUrl);
				expect(await driven.evaluate(() => document.visibilityState)).toBe("hidden");
				expect(await nativeRecoveryDocument(user)).toBe(userDocumentId);
				expect(user.url()).toBe(userUrl);
			}
			await releaseTab(name);
			expect(driven.isClosed()).toBeFalse();
			expect(user.isClosed()).toBeFalse();
			if (failedRead) throw failedRead;
		} finally {
			try {
				if (relay) {
					await releaseTab(name).catch(() => undefined);
					await releaseBrowser(relay, { kill: false });
				}
			} finally {
				try {
					await fixture?.close();
				} finally {
					await fs.rm(vaultDir, { recursive: true, force: true });
				}
			}
		}
	}, 60_000);

	it("leaves an extension save card and its neighboring page frames unchanged", async () => {
		const vaultDir = await writeStandInVault(
			`document.addEventListener("submit", () => {
	const card = document.createElement("vault-notification");
	const frame = document.createElement("iframe");
	card.attachShadow({ mode: "closed" }).append(frame);
	document.documentElement.append(card);
	frame.src = chrome.runtime.getURL("notification.html");
}, true);`,
		);
		const fixture = await launchRelayFixture(undefined, [vaultDir]);
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-vault-submit-${process.pid}`;
		try {
			await acquireTab(name, relay, {
				url: `${fixture.origin}/login?who=submit`,
				timeoutMs: 20_000,
			});
			const page = (await fixture.browser.pages()).find(page => page.url().includes("who=submit"));
			if (!page) throw new Error("omp's tab is gone");
			const vaultId = await unpackedExtensionId(vaultDir);
			if (!vaultId) throw new Error("Missing stand-in vault directory");
			const card = `chrome-extension://${vaultId}/notification.html`;
			const neighboringFrames = [
				`chrome-extension://${"p".repeat(32)}/decoy.html`,
				`chrome-extension://${vaultId}/private.html`,
				`chrome-extension://${vaultId}/Page text/../notification.html`,
			];
			await page.evaluate(`
        for (const src of ${JSON.stringify(neighboringFrames)}) {
          const frame = document.createElement("iframe");
          frame.src = src;
          document.body.append(frame);
        }
        document.querySelector("form").requestSubmit();
      `);
			await page.waitForFrame(frame => frame.url() === card);
			const original = await frameAttributes(page, card);
			await checkTitleWithoutHidingFrame(name, "Signed in");
			expect(await frameAttributes(page, card)).toEqual(original);
			expect(original).not.toContain("srcdoc");
			for (const url of neighboringFrames) expect(await frameAttributes(page, url)).not.toContain("srcdoc");
			expect(await page.title()).toBe("Signed in");
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
			await fs.rm(vaultDir, { recursive: true, force: true });
		}
	}, 60_000);
	it("closes an owned relay tab whose debugger the user dismissed", async () => {
		const detached = Promise.withResolvers<void>();
		let ownedTabId = 0;
		const fixture = await launchRelayFixture((message, data) => {
			if (message === "tab detached" && typeof data?.tabKey === "string" && data.tabKey.endsWith(`:${ownedTabId}`))
				detached.resolve();
		});
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-detached-${process.pid}`;
		const otherName = `relay-detached-other-${process.pid}`;
		try {
			const human = await fixture.browser.newPage();
			await human.goto(`${fixture.origin}/human`);
			const { tab: other } = await acquireTab(otherName, relay, {
				url: `${fixture.origin}/second`,
				timeoutMs: 20_000,
			});
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			ownedTabId = chromeTabId(tab.targetId);
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeTrue();
			// Replay the infobar dismissal through the extension's real listener.
			const result = await fixture.inExtension(
				`chrome.runtime.sendMessage({ op: "dismissDebugger", tabId: ${ownedTabId} })`,
			);
			expect(result).toEqual({});
			await detached.promise;
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeFalse();
			expect(await chromeTab(fixture, ownedTabId)).not.toBeNull();
			await releaseTab(name);
			expect(await chromeTab(fixture, ownedTabId)).toBeNull();
			expect(await chromeTab(fixture, chromeTabId(other.targetId))).not.toBeNull();
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseTab(otherName).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("leaves page and cross-site frame downloads untouched and does not report their paths", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-download-${process.pid}`;
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/download`, timeoutMs: 15_000 });
			await runInTab(name, { code: "await tab.click('#report');", timeoutMs: 20_000, session });
			await waitForFixtureDownload(path.join(fixture.downloads, "report.csv"));
			await expectRelayDownloadTrackingRejected(name);
			await runInTab(name, {
				code: `await tab.goto(${JSON.stringify(`${fixture.origin}/framed`)}); await (await tab.frame('iframe')).click('#report');`,
				timeoutMs: 20_000,
				session,
			});
			await waitForFixtureDownload(path.join(fixture.downloads, "report (1).csv"));
			await expectRelayDownloadTrackingRejected(name);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("leaves two same-URL downloads to Chrome even when the later one finishes first", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-download-held-${process.pid}`;
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/download`, timeoutMs: 15_000 });
			await runInTab(name, { code: "await tab.click('#held');", timeoutMs: 20_000, session });
			const first = await fixture.heldDownload(0);
			await runInTab(name, { code: "await tab.click('#held');", timeoutMs: 20_000, session });
			const second = await fixture.heldDownload(1);
			await expectRelayDownloadTrackingRejected(name);
			second.resolve();
			await waitForFixtureDownload(path.join(fixture.downloads, "held (1).csv"));
			expect(await Bun.file(path.join(fixture.downloads, "held.csv")).exists()).toBeFalse();
			first.resolve();
			await waitForFixtureDownload(path.join(fixture.downloads, "held.csv"));
			await expectRelayDownloadTrackingRejected(name);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("owned tab recovery", () => {
	it("keeps an owned target alive after a failed recovery init so a retry can adopt it", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected Chromium");
		const page = await launched.browser.newPage();
		await page.goto("data:text/html,<title>Recovery sentinel</title>");
		const target = page.target();
		if (!("_targetId" in target) || typeof target._targetId !== "string") throw new Error("Missing target ID");
		const payload: WorkerInitPayload = {
			mode: "attach",
			browserWSEndpoint: launched.wsEndpoint,
			safeDir: getPuppeteerDir(),
			uploadDir: "/tmp/omp-uploads-test",
			page: { kind: "owned", targetId: target._targetId },
			recover: true,
		};
		const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-download-"));
		const blockedDownloadPath = path.join(downloadDir, "not-a-directory");
		await fs.writeFile(blockedDownloadPath, "existing file");
		const failed = startWorker({ ...payload, downloadsPath: blockedDownloadPath });
		let retried: TestWorker | undefined;
		try {
			expect((await failed.outcome).type).toBe("init-failed");
			expect(page.isClosed()).toBeFalse();
			retried = startWorker(payload);
			const ready = await retried.outcome;
			if (ready.type !== "ready") throw new Error("Expected the retry to adopt the owned target");
			expect(ready.info.targetId).toBe(target._targetId);
			await retried.close();
			retried = undefined;
			// Closing the worker that owns the page closes it. Ask Chrome: this connection's `page`
			// learns of the close only once its own target event arrives.
			const { targetInfos } = await launched.browser
				.target()
				.createCDPSession()
				.then(async session => {
					const targets = await session.send("Target.getTargets");
					await session.detach();
					return targets;
				});
			expect(targetInfos.map(info => info.targetId)).not.toContain(target._targetId);
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await fs.rm(downloadDir, { recursive: true, force: true });
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);
});
