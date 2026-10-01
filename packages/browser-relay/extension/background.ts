/**
 * OMP Browser Relay — MV3 service worker.
 *
 * Dumb pipe by design: all CDP orchestration lives in the relay server. This
 * worker (1) keeps a websocket to the relay, (2) executes its RPCs against
 * `chrome.debugger`/`chrome.tabs`, and (3) streams tab + debugger events back.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the
 * worker alive while connected (Chrome 116+); a chrome.alarms tick revives it
 * and re-dials after Chrome reaps it while disconnected. Each dial probes the
 * port with a fetch first: a refused WebSocket is logged into the extension's
 * error list by Chrome's network layer on every attempt, a refused fetch is not.
 */
import type { ExtToRelayMessage, RelayToExtMessage, TabSnapshot } from "../../coding-agent/src/tools/browser/relay/protocol";

import { ScreenshotCapture } from "./screenshot-capture";

const screenshotCapture = new ScreenshotCapture(
	(target, method, params) => chrome.debugger.sendCommand(target, method, params),
	async tabId => {
		const tab = await chrome.tabs.get(tabId);
		return (await chrome.windows.get(tab.windowId)).state === "minimized";
	},
);

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
/** The 30s keepalive alarm also re-dials; omp's relay wait assumes one dial per alarm period. */
const RECONNECT_MAX_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: NodeJS.Timeout | null = null;
let dialing = false;
let pingTimer: NodeJS.Timeout | null = null;
const relayInitiatedDetachTabs = new Set<number>();

/**
 * Tab ids this extension created for omp (`createTab`), reported in hello as
 * `ownedTabIds`. The relay's orphan reaper closes only these, so a record left
 * by a crashed omp session can never close a user tab. `chrome.storage.session`
 * survives service-worker restarts and is cleared with the browser session,
 * exactly when Chrome starts reusing tab ids.
 */
const CREATED_TABS_KEY = "ompCreatedTabIds";
let createdTabs: Promise<Set<number>> | null = null;
function loadCreatedTabs(): Promise<Set<number>> {
	createdTabs ??= chrome.storage.session
		.get({ [CREATED_TABS_KEY]: [] })
		.then(stored => {
			const raw = stored[CREATED_TABS_KEY];
			return new Set(Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number") : []);
		})
		.catch(() => new Set<number>());
	return createdTabs;
}

async function markCreatedTab(tabId: number, created: boolean): Promise<void> {
	const ids = await loadCreatedTabs();
	if (created === ids.has(tabId)) return;
	if (created) ids.add(tabId);
	else ids.delete(tabId);
	await chrome.storage.session.set({ [CREATED_TABS_KEY]: [...ids] }).catch(() => {});
}

/**
 * Stable per-install browser identity, persisted in `chrome.storage.local` and
 * sent in every hello. The relay namespaces tab registries per instance, so
 * several browsers can share one relay and a service-worker restart keeps the
 * browser's tab registry instead of replacing another browser's connection.
 */
let instanceId: string | null = null;
async function ensureInstanceId(): Promise<string> {
	if (instanceId) return instanceId;
	const key = "relayInstanceId";
	const stored = await chrome.storage.local.get({ [key]: "" });
	const existing = stored[key];
	instanceId = typeof existing === "string" && existing.length > 0 ? existing : crypto.randomUUID();
	await chrome.storage.local.set({ [key]: instanceId } as Record<string, string>);
	return instanceId;
}

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not
 * atomic: two concurrent runs both miss the not-yet-titled group and mint
 * duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();
function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}

/** Move tabs into their named per-window omp session group, creating or reusing it by title. */
async function groupTabs(tabIds: number[], title: string, color: string): Promise<{ grouped: Record<string, number> }> {
	const byWindow = new Map<number, number[]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			// Grouping silently unpins; never touch pinned tabs.
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId) ?? [];
			bucket.push(tab.id);
			byWindow.set(tab.windowId, bucket);
		} catch {
			// Tab already closed.
		}
	}
	const grouped: Record<string, number> = {};
	for (const [windowId, ids] of byWindow) {
		const existing = await chrome.tabGroups.query({ title, windowId });
		let groupId: number;
		if (existing[0]) {
			groupId = existing[0].id;
			// Heal duplicate same-title groups left behind by older races.
			for (const dupe of existing.slice(1)) {
				const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
				const dupeIds = dupeTabs.map(tab => tab.id).filter(id => id !== undefined);
				if (dupeIds.length > 0) await chrome.tabs.group({ tabIds: dupeIds, groupId });
			}
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids });
		}
		await chrome.tabGroups.update(groupId, { title, color });
		for (const id of ids) grouped[String(id)] = groupId;
	}
	return { grouped };
}

/** Dissolve all omp session groups when the relay disconnects. */
async function restoreGroups(): Promise<void> {
	const groups = await chrome.tabGroups.query({}).catch(() => []);
	for (const group of groups) {
		if (group.title !== "omp" && !group.title?.startsWith("omp/")) continue;
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map(tab => tab.id).filter(id => id !== undefined);
		if (ids.length > 0) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

async function buildHello(): Promise<ExtToRelayMessage> {
	const [tabs, targets, created] = await Promise.all([
		chrome.tabs.query({}),
		chrome.debugger.getTargets(),
		loadCreatedTabs(),
	]);
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	const attachedTabIds: number[] = [];
	for (const target of targets) {
		if (target.attached && target.tabId !== undefined) attachedTabIds.push(target.tabId);
	}
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		instanceId: await ensureInstanceId(),
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		tabs: snapshots,
		attachedTabIds,
		ownedTabIds: snapshots.filter(snap => created.has(snap.tabId)).map(snap => snap.tabId),
	};
}

/**
 * Window for a new background tab. Without an explicit `windowId`,
 * `chrome.tabs.create` rejects with "No current window" whenever every Chrome
 * window is minimized; prefer the focused window, then a visible one, then any
 * normal window (a minimized window still accepts tabs without restoring it).
 */
async function tabWindowId(): Promise<number | undefined> {
	const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
	const chosen =
		windows.find(window => window.focused) ??
		windows.find(window => window.state !== "minimized") ??
		windows[0];
	return chosen?.id;
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>): Promise<unknown> {
	switch (msg.op) {
		case "attach":
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			return {};
		case "detach":
			relayInitiatedDetachTabs.add(msg.tabId);
			try {
				await chrome.debugger.detach({ tabId: msg.tabId });
				return {};
			} catch (error) {
				relayInitiatedDetachTabs.delete(msg.tabId);
				throw error;
			}
		case "send":
			return await screenshotCapture.send(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url, active: false, windowId: await tabWindowId() });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			await markCreatedTab(snap.tabId, true);
			return { tab: snap };
		}
		case "removeTab":
			await chrome.tabs.remove(msg.tabId);
			return {};
		case "activateTab": {
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
		case "ungroup":
			await enqueueGroupOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
			return {};
	}
}

function handleRelayMessage(raw: string): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	void runRpc(msg)
		.then(result => post({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err: unknown) => {
			post({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

/** Single retry timer: alarm-driven dials must not each start another backoff chain. */
function scheduleReconnect(): void {
	if (reconnectTimer !== null) return;
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void connect();
	}, delay);
}

/** True when something answers HTTP on the relay port; a refused fetch leaves no extension error entry. */
async function relayListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/json/version`, {
			mode: "no-cors",
			cache: "no-store",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		return true;
	} catch {
		return false;
	}
}

async function connect(): Promise<void> {
	if (dialing || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
	dialing = true;
	try {
		const settings = await loadSettings();
		if (!(await relayListening(settings.port))) {
			scheduleReconnect();
			return;
		}
		const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
		const socket = new WebSocket(url);
		ws = socket;
		socket.onopen = () => {
			reconnectDelay = RECONNECT_MIN_MS;
			void setBadge(true);
			void buildHello().then(hello => post(hello));
			clearInterval(pingTimer ?? undefined);
			pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
		};
		socket.onmessage = event => {
			if (typeof event.data === "string") handleRelayMessage(event.data);
		};
		socket.onclose = () => {
			if (ws !== socket) return;
			ws = null;
			if (pingTimer !== null) {
				clearInterval(pingTimer);
				pingTimer = null;
			}
			void setBadge(false);
			void enqueueGroupOp(restoreGroups);
			scheduleReconnect();
		};
		socket.onerror = () => {
			socket.close();
		};
	} finally {
		dialing = false;
	}
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	const target = { tabId: source.tabId, sessionId: source.sessionId };
	if (screenshotCapture.handleEvent(target, method, params)) return;
	if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
		screenshotCapture.detach({ tabId: source.tabId, sessionId: params.sessionId });
	}
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	screenshotCapture.detach({ tabId: source.tabId });
	const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
});

chrome.tabs.onCreated.addListener(tab => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onRemoved.addListener(tabId => {
	screenshotCapture.detach({ tabId });
	void markCreatedTab(tabId, false);
	post({ t: "tabRemoved", tabId });
});

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "omp-relay-keepalive") void connect();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
	if (areaName !== "local") return;
	// Settings changed: drop the current connection and re-dial with new ones.
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => {
	// A click is also a cheap way to re-dial a relay that just came up.
	void connect();
	void chrome.runtime.openOptionsPage();
});
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());

void connect();
