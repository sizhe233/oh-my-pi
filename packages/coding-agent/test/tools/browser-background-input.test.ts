import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	type BrowserHandle,
	type BrowserKind,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer, { type Browser, type Page, type WebWorker } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

const site = Bun.serve({
	port: 0,
	fetch(request) {
		const html =
			new URL(request.url).pathname === "/target"
				? `<title>Target</title><button onclick="this.textContent='clicked'">Click</button><p id="hover" onmouseover="this.textContent='hovered'">Hover</p>`
				: "<title>Human</title><h1>Keep me</h1>";
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	},
});
const origin = `http://127.0.0.1:${site.port}`;
afterAll(() => site.stop(true));

async function openHuman(browser: Browser): Promise<Page> {
	const human = await browser.newPage();
	await human.goto(`${origin}/human`);
	await human.bringToFront();
	return human;
}

/** Open an unrelated selected page, then create a genuinely hidden borrowed fixture. */
async function openTabs(browser: Browser, openBackground: (url: string) => Promise<unknown>): Promise<Page> {
	await openHuman(browser);
	await openBackground(`${origin}/target`);
	const target = await (await browser.waitForTarget(t => t.url() === `${origin}/target`)).page();
	if (!target) throw new Error("Missing background page");
	await target.waitForFunction("document.readyState === 'complete'");
	expect(await target.evaluate(() => document.visibilityState)).toBe("hidden");
	return target;
}

/** Resolves once the page reads hidden: a session ends after omp's connection closes, a beat after the release. */
async function waitHidden(target: Page): Promise<void> {
	// rAF polling would never fire in the hidden tab this waits for.
	await target.waitForFunction(() => document.visibilityState === "hidden", { polling: 50, timeout: 5_000 });
}

/** Hovers and clicks the background page through omp, then releases it; hover needs a rendered frame, which a hidden tab never produces. */
async function driveAndRelease(kind: BrowserKind, browser: Browser): Promise<void> {
	const handle: BrowserHandle = await acquireBrowser(kind, { cwd: process.cwd() });
	const name = `background-${kind.kind}-${process.pid}`;
	try {
		const { tab } = await acquireTab(name, handle, { url: `${origin}/target`, timeoutMs: 15_000 });
		if (tab.backend !== "worker") throw new Error("Expected a worker tab");
		expect(tab.ownsPage).toBe(true);
		const target = await (await browser.waitForTarget(t => t.url() === `${origin}/target`)).page();
		if (!target) throw new Error("Missing owned background page");
		const result = await runInTab(name, {
			code: "await tab.hover('#hover'); await tab.click('button'); return [await tab.text('#hover'), await tab.text('button')];",
			timeoutMs: 10_000,
			session,
		});
		expect(result.returnValue).toEqual(["hovered", "clicked"]);
		await releaseTab(name, { keepPage: true });
		// The page must not stay focus-emulated once omp lets it go.
		await waitHidden(target);
	} finally {
		await releaseTab(name).catch(() => undefined);
		await releaseBrowser(handle, { kill: false });
	}
}

interface RelayFixture {
	browser: Browser;
	cdpUrl: string;
	/** The relay extension's service worker, for reading Chrome's own tab state. */
	extension: WebWorker;
	/** The page omp drives, open in a background tab. */
	target: Page;
}

/** Headless Chromium running the real relay extension against a relay on a free port, with the tabs of {@link openTabs}. */
async function withRelay(run: (fixture: RelayFixture) => Promise<void>, owned = false): Promise<void> {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false });
	const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-background-"));
	let browser: Browser | undefined;
	try {
		for (const file of ["manifest.json", "options.html", "options.js"]) {
			await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(extensionDir, file));
		}
		const background = await Bun.file(path.join(ASSETS, "background.js.txt")).text();
		// Point the disposable extension at this relay before its code can dial a user's default relay.
		await Bun.write(
			path.join(extensionDir, "background.js"),
			`chrome.storage.local.set({ port: ${port} }).then(() => {\n${background}\n});`,
		);
		browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extensionDir],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		const extension = await (
			await browser.waitForTarget(target => target.type() === "service_worker", { timeout: 15_000 })
		).worker();
		if (!extension) throw new Error("Missing relay extension worker");
		const cdpUrl = `http://127.0.0.1:${port}`;
		expect(await waitForRelayExtension(cdpUrl)).toBe("ready");
		const target = owned
			? await openHuman(browser)
			: await openTabs(browser, url =>
					extension.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false })`),
				);
		await run({ cdpUrl, extension, target, browser });
	} finally {
		await browser?.close();
		server.stop();
		await fs.rm(extensionDir, { recursive: true, force: true });
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("background tab input", () => {
	it("drives an owned relay tab in the background without selecting it", async () => {
		await withRelay(async ({ cdpUrl, extension, browser }) => {
			// The relay keeps the tab's debugger session after omp lets go, so the release must end the emulation itself.
			await driveAndRelease({ kind: "relay", cdpUrl }, browser);
			expect(
				await extension.evaluate(
					"chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0]?.url)",
				),
			).toBe(`${origin}/human`);
		}, true);
	}, 60_000);

	it("rejects a competing relay borrower until release, then allows another name", async () => {
		await withRelay(async ({ cdpUrl, target }) => {
			const handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
			const names = [`background-first-${process.pid}`, `background-second-${process.pid}`];
			try {
				await acquireTab(names[0]!, handle, { target: "Target", timeoutMs: 15_000 });
				await expect(acquireTab(names[1]!, handle, { target: "Target", timeoutMs: 15_000 })).rejects.toThrow(
					/already drives that page/,
				);
				await releaseTab(names[0]!);
				await acquireTab(names[1]!, handle, { target: "Target", timeoutMs: 15_000 });
				const result = await runInTab(names[1]!, {
					code: "return await tab.title();",
					timeoutMs: 10_000,
					session,
				});
				expect(result.returnValue).toBe("Target");
				await releaseTab(names[1]!);
				await waitHidden(target);
			} finally {
				for (const name of names) await releaseTab(name).catch(() => undefined);
				await releaseBrowser(handle, { kill: false });
			}
		});
	}, 60_000);

	it("keeps a borrowed relay page hidden and open when its worker dies", async () => {
		await withRelay(async ({ cdpUrl, target }) => {
			const handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
			const name = `background-killed-${process.pid}`;
			// Another live tab keeps omp's relay connection, and with it the page's debugger session, attached.
			const other = `background-other-${process.pid}`;
			try {
				await acquireTab(other, handle, { target: "Human", timeoutMs: 15_000 });
				await acquireTab(name, handle, { target: "Target", timeoutMs: 15_000 });
				expect(await target.evaluate(() => document.visibilityState)).toBe("hidden");
				const tab = getTabsMapForTest().get(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				await tab.worker.terminate();
				await releaseTab(name);
				await waitHidden(target);
				expect(target.isClosed()).toBe(false);
			} finally {
				for (const tab of [name, other]) await releaseTab(tab).catch(() => undefined);
				await releaseBrowser(handle, { kill: false });
			}
		});
	}, 60_000);

	it("drives an owned app CDP URL tab in the background", async () => {
		const port = await findFreeCdpPort();
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			args: [
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				`--remote-debugging-port=${port}`,
			],
		});
		try {
			const human = await openHuman(browser);
			await driveAndRelease({ kind: "connected", cdpUrl: `http://127.0.0.1:${port}` }, browser);
			expect(await human.evaluate(() => document.visibilityState)).toBe("visible");
		} finally {
			await browser.close();
		}
	}, 60_000);
});
