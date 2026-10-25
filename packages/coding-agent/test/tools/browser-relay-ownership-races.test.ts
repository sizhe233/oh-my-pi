import { afterEach, describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayToExtMessage, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function flush(): Promise<void> {
	for (let i = 0; i < 60; i++) await Promise.resolve();
}
interface Reply {
	id?: number;
	result?: { sessionId?: string };
	error?: unknown;
	method?: string;
}
class CdpSocket implements RelaySocket {
	readonly messages: Reply[] = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text));
	}
	close(): void {}
}
const tab: TabSnapshot = {
	tabId: 9,
	url: "https://example.com/",
	title: "Created",
	active: false,
	discarded: false,
	windowId: 44,
	pinned: false,
	groupId: -1,
};

/** Execute the shipped extension bundle against browser-API gates and the real relay producer/consumer. */
async function extensionFixture(options: { dropHelloAck?: boolean } = {}) {
	const bridge = new RelayBridge();
	const sockets: ExtensionSocket[] = [];
	cleanups.push(() => {
		for (const socket of sockets) socket.close();
	});
	const timers: Array<{ callback: () => void; delay: number }> = [];
	const removed: number[] = [];
	let createCalls = 0;
	let lookupFails = false;
	const createResult = Promise.withResolvers<object>();
	const stored: Record<string, unknown> = { relayBrowserSession: "run-1" };
	let onCreated: (value: object) => void = () => {};
	let onRemoved: (tabId: number) => void = () => {};
	let browserTabs: Array<{ id: number }> = [];
	let dropAcknowledgments = false;
	const event = { addListener() {} };
	class ExtensionSocket {
		static OPEN = 1;
		static CONNECTING = 0;
		readyState = 1;
		onopen?: () => void;
		onclose?: () => void;
		onmessage?: (event: { data: string }) => void;
		readonly outbound: Array<{ t: string; id?: number }> = [];
		readonly peer: RelaySocket = {
			send: text => {
				if (dropAcknowledgments && JSON.parse(text).t === "abandonedTabHandled") return;
				if (options.dropHelloAck && JSON.parse(text).t === "helloAck") return;
				this.onmessage?.({ data: text });
			},
			close: () => this.close(),
		};
		constructor() {
			sockets.push(this);
			bridge.extConnected(this.peer);
		}
		send(text: string): void {
			this.outbound.push(JSON.parse(text));
			bridge.extMessage(this.peer, text);
		}
		close(): void {
			if (this.readyState === 3) return;
			this.readyState = 3;
			bridge.extClosed(this.peer);
			this.onclose?.();
		}
	}
	const chrome = {
		tabs: {
			async query() {
				return browserTabs;
			},
			async get(id: number) {
				if (lookupFails) throw new Error("Browser API temporarily unavailable");
				const found = browserTabs.find(value => value.id === id);
				if (!found) throw new Error(`No tab with id ${id}`);
				return found;
			},
			async create() {
				createCalls++;
				return await createResult.promise;
			},
			async remove(id: number) {
				removed.push(id);
				browserTabs = browserTabs.filter(value => value.id !== id);
				onRemoved(id);
			},
			onCreated: {
				addListener(fn: (value: object) => void) {
					onCreated = fn;
				},
			},
			onRemoved: {
				addListener(fn: (id: number) => void) {
					onRemoved = fn;
				},
			},
			onUpdated: event,
			onActivated: event,
		},
		windows: {
			async getAll() {
				return [{ id: 44, state: "minimized", focused: false }];
			},
		},
		storage: {
			local: {
				async get(defaults: object) {
					return { ...defaults, relayInstanceId: "chrome" };
				},
				async set() {},
			},
			session: {
				async get(defaults: object) {
					return { ...defaults, ...stored };
				},
				async set(values: object) {
					Object.assign(stored, values);
				},
			},
			onChanged: event,
		},
		debugger: {
			async getTargets() {
				return [];
			},
			async attach() {},
			async detach() {},
			onEvent: event,
			onDetach: event,
		},
		tabGroups: {
			async query() {
				return [];
			},
		},
		alarms: { create() {}, onAlarm: event },
		action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, onClicked: event },
		runtime: { onInstalled: event, onStartup: event },
	};
	const bundle = await Bun.file(
		new URL("../../src/tools/browser/relay/extension-assets/background.js.txt", import.meta.url),
	).text();
	async function startWorker(): Promise<void> {
		vm.runInNewContext(bundle, {
			chrome,
			WebSocket: ExtensionSocket,
			AbortSignal,
			navigator: { userAgent: "Chrome/151.0.0.0" },
			fetch: async () => ({}),
			setTimeout: (callback: () => void, delay: number) => {
				timers.push({ callback, delay });
				return timers.length;
			},
			clearTimeout() {},
			setInterval: () => 0,
			clearInterval() {},
		});
		await flush();
		sockets.at(-1)!.onopen?.();
		await flush();
	}
	await startWorker();
	const creatorSocket = new CdpSocket();
	const creator = bridge.cdpConnected(creatorSocket);
	bridge.cdpMessage(creator, JSON.stringify({ id: 1, method: "Target.createTarget" }));
	await flush();
	const origin = sockets[0]!;
	origin.close();
	await flush();
	async function reconnect(): Promise<void> {
		const index = timers.findIndex(timer => timer.delay === 1_000);
		if (index < 0) throw new Error("Missing reconnect timer");
		timers.splice(index, 1)[0]!.callback();
		await flush();
		sockets.at(-1)!.onopen?.();
		await flush();
	}
	async function announce(): Promise<void> {
		const actual = { id: tab.tabId, ...tab };
		browserTabs = [actual];
		onCreated(actual);
		await flush();
	}
	async function completeCreate(): Promise<void> {
		createResult.resolve({ id: tab.tabId, ...tab });
		await flush();
	}
	async function adopt(): Promise<number> {
		const targetId = bridge.listTargets()[0]!.id;
		const driverSocket = new CdpSocket();
		const driver = bridge.cdpConnected(driverSocket);
		bridge.cdpMessage(
			driver,
			JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId, flatten: true } }),
		);
		await flush();
		const sessionId = driverSocket.messages.find(message => message.id === 2)?.result?.sessionId;
		expect(typeof sessionId).toBe("string");
		bridge.cdpMessage(driver, JSON.stringify({ id: 3, method: "OMP.claimTarget", sessionId }));
		await flush();
		expect(driverSocket.messages.find(message => message.id === 3)?.result).toEqual({});
		return driver;
	}
	return {
		bridge,
		sockets,
		origin,
		stored,
		removed,
		creatorSocket,
		createCalls: () => createCalls,
		failLookup: () => {
			lookupFails = true;
		},
		reconnect,
		announce,
		completeCreate,
		adopt,
		startWorker,
		dropAcknowledgments: (drop: boolean) => {
			dropAcknowledgments = drop;
		},
	};
}

describe("shipped relay extension late-create arbitration", () => {
	it("preserves a late-created tab adopted through the replacement connection", async () => {
		const fixture = await extensionFixture();
		await fixture.reconnect();
		await fixture.announce();
		await fixture.adopt();
		await fixture.completeCreate();
		expect(fixture.removed).toEqual([]);
		expect(fixture.bridge.listTargets()).toHaveLength(1);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
		// A delayed create reply must never be sent on the new socket's RPC id space.
		expect(fixture.sockets[1]!.outbound.filter(message => message.t === "rpcResult" && message.id === 1)).toEqual([]);
		expect(fixture.creatorSocket.messages.find(message => message.id === 1)).toHaveProperty("error");
	});

	it("consumes adoption permanently before the driver releases and the extension reconnects", async () => {
		const fixture = await extensionFixture();
		await fixture.reconnect();
		await fixture.announce();
		const driver = await fixture.adopt();
		await fixture.completeCreate();
		fixture.bridge.cdpClosed(driver);
		fixture.sockets.at(-1)!.close();
		await fixture.startWorker();
		expect(fixture.removed).toEqual([]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
		expect(fixture.bridge.listTargets()).toHaveLength(1);
	});

	it("preserves a prior adoption even if its driver released before the late create callback", async () => {
		const fixture = await extensionFixture();
		await fixture.reconnect();
		await fixture.announce();
		fixture.bridge.cdpClosed(await fixture.adopt());
		await fixture.completeCreate();
		expect(fixture.removed).toEqual([]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
	});

	it("closes an unclaimed late create through the relay and consumes its pending record", async () => {
		const fixture = await extensionFixture();
		await fixture.reconnect();
		await fixture.announce();
		await fixture.completeCreate();
		expect(fixture.removed).toEqual([9]);
		expect(fixture.bridge.listTargets()).toEqual([]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
	});

	it("persists an offline late create and resumes cleanup after a service-worker restart", async () => {
		const fixture = await extensionFixture();
		await fixture.announce();
		await fixture.completeCreate();
		expect(fixture.removed).toEqual([]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([9]);
		await fixture.startWorker();
		expect(fixture.removed).toEqual([9]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
	});

	it("retains an abandoned create after a transient tab lookup failure and retries on reconnect", async () => {
		const fixture = await extensionFixture();
		await fixture.reconnect();
		await fixture.announce();
		fixture.failLookup();
		await fixture.completeCreate();
		expect(fixture.removed).toEqual([]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([9]);
		fixture.sockets.at(-1)!.close();
		await fixture.startWorker();
		expect(fixture.removed).toEqual([9]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
	});

	it("ignores an acknowledgment delivered through the retired socket", async () => {
		const fixture = await extensionFixture();
		await fixture.announce();
		await fixture.completeCreate();
		fixture.origin.onmessage?.({ data: JSON.stringify({ t: "abandonedTabHandled", tabId: 9 }) });
		await flush();
		expect(fixture.stored.ompAbandonedTabIds).toEqual([9]);
		await fixture.startWorker();
		expect(fixture.removed).toEqual([9]);
	});

	it("retains an unacknowledged report and consumes it safely after adoption and restart", async () => {
		const fixture = await extensionFixture();
		await fixture.reconnect();
		await fixture.announce();
		fixture.dropAcknowledgments(true);
		const driver = await fixture.adopt();
		await fixture.completeCreate();
		expect(fixture.stored.ompAbandonedTabIds).toEqual([9]);
		fixture.bridge.cdpClosed(driver);
		fixture.sockets.at(-1)!.close();
		fixture.dropAcknowledgments(false);
		await fixture.startWorker();
		expect(fixture.removed).toEqual([]);
		expect(fixture.stored.ompAbandonedTabIds).toEqual([]);
	});
});

class ExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text));
	}
	close(): void {}
}
function bridgeFixture(options: { protocol?: number } = { protocol: 1 }) {
	const bridge = new RelayBridge();
	const ext = new ExtSocket();
	cleanups.push(() => bridge.extClosed(ext));
	bridge.extConnected(ext);
	bridge.extMessage(
		ext,
		JSON.stringify({
			t: "hello",
			instanceId: "closing",
			browserSession: "run",
			userAgent: "test",
			browserVersion: "Chrome/151",
			discardedTabsProtocol: 1,
			abandonedTabsProtocol: options.protocol,
			tabs: [tab],
			attachedTabIds: [],
			ownedTabIds: [9],
		}),
	);
	const targetId = bridge.listTargets()[0]!.id;
	const driver = new CdpSocket();
	const driverId = bridge.cdpConnected(driver);
	function request(id: number, method: string, sessionId?: string): void {
		bridge.cdpMessage(driverId, JSON.stringify({ id, method, sessionId, params: { targetId, flatten: true } }));
	}
	function reply(op: "attach" | "removeTab", ok = true): void {
		const message = [...ext.messages].reverse().find(value => value.t === "rpc" && value.op === op);
		if (!message || message.t !== "rpc") throw new Error(`Missing ${op} RPC`);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "rpcResult",
				id: message.id,
				ok,
				result: {},
				error: ok ? undefined : "Chrome temporarily refused removal",
			}),
		);
	}
	function abandon(): void {
		bridge.extMessage(ext, JSON.stringify({ t: "abandonedTab", tab }));
	}
	return { bridge, ext, driver, driverId, targetId, request, reply, abandon };
}

describe("relay closing excludes new ownership", () => {
	it("rejects attach while an unclaimed abandoned target is being removed, then permits it after failure", async () => {
		const fixture = bridgeFixture();
		// This older path already exists before the abandonment protocol change.
		fixture.request(1, "Target.closeTarget");
		await flush();
		fixture.request(2, "Target.attachToTarget");
		await flush();
		const failure = fixture.driver.messages.find(message => message.id === 2);
		fixture.reply("removeTab", false);
		await flush();
		// Clean up any wrongly issued attach before asserting the failure.
		if (fixture.ext.messages.some(message => message.t === "rpc" && message.op === "attach")) fixture.reply("attach");
		await flush();
		expect(failure).toHaveProperty("error");
		fixture.request(3, "Target.attachToTarget");
		await flush();
		fixture.reply("attach");
		await flush();
		expect(fixture.driver.messages.find(message => message.id === 3)?.result?.sessionId).toBeString();
	});

	it("rejects an attach that completes only after removal starts", async () => {
		const fixture = bridgeFixture();
		fixture.request(1, "Target.attachToTarget");
		await flush();
		fixture.request(2, "Target.closeTarget");
		await flush();
		fixture.reply("attach");
		await flush();
		const attached = fixture.driver.messages.find(message => message.id === 1);
		fixture.reply("removeTab", false);
		await flush();
		expect(attached).toHaveProperty("error");
	});

	it("rejects a new claim through an existing session while removal is in flight", async () => {
		const fixture = bridgeFixture();
		fixture.request(1, "Target.attachToTarget");
		await flush();
		fixture.reply("attach");
		await flush();
		const sessionId = fixture.driver.messages.find(message => message.id === 1)?.result?.sessionId;
		expect(sessionId).toBeString();
		fixture.request(2, "Target.closeTarget");
		await flush();
		fixture.request(3, "OMP.claimTarget", sessionId);
		await flush();
		const claim = fixture.driver.messages.find(message => message.id === 3);
		fixture.reply("removeTab", false);
		await flush();
		expect(claim).toHaveProperty("error");
		fixture.request(4, "OMP.claimTarget", sessionId);
		await flush();
		expect(fixture.driver.messages.find(message => message.id === 4)?.result).toEqual({});
	});

	it("does not carry an adoption latch into a new browser incarnation reusing the tab id", async () => {
		const fixture = bridgeFixture();
		fixture.request(1, "Target.attachToTarget");
		await flush();
		fixture.reply("attach");
		await flush();
		const sessionId = fixture.driver.messages.find(message => message.id === 1)?.result?.sessionId;
		fixture.request(2, "OMP.claimTarget", sessionId);
		await flush();
		expect(fixture.driver.messages.find(message => message.id === 2)?.result).toEqual({});
		fixture.bridge.extMessage(
			fixture.ext,
			JSON.stringify({
				t: "hello",
				instanceId: "closing",
				browserSession: "new-run",
				userAgent: "test",
				browserVersion: "Chrome/151",
				discardedTabsProtocol: 1,
				abandonedTabsProtocol: 1,
				tabs: [tab],
				attachedTabIds: [],
				ownedTabIds: [9],
				abandonedTabIds: [9],
			}),
		);
		await flush();
		expect(fixture.bridge.listTargets()[0]?.id).not.toBe(fixture.targetId);
		expect(fixture.ext.messages.filter(message => message.t === "rpc" && message.op === "removeTab")).toHaveLength(1);
		fixture.bridge.extMessage(fixture.ext, JSON.stringify({ t: "tabRemoved", tabId: 9 }));
		fixture.reply("removeTab");
		await flush();
		expect(fixture.ext.messages.filter(message => message.t === "abandonedTabHandled")).toEqual([
			{ t: "abandonedTabHandled", tabId: 9 },
		]);
	});

	it("keeps a failed abandoned close pending and retries it on the next hello", async () => {
		const fixture = bridgeFixture();
		fixture.abandon();
		await flush();
		fixture.reply("removeTab", false);
		await flush();
		expect(fixture.ext.messages.filter(message => message.t === "abandonedTabHandled")).toEqual([]);
		fixture.bridge.extMessage(
			fixture.ext,
			JSON.stringify({
				t: "hello",
				instanceId: "closing",
				browserSession: "run",
				userAgent: "test",
				browserVersion: "Chrome/151",
				discardedTabsProtocol: 1,
				abandonedTabsProtocol: 1,
				tabs: [tab],
				attachedTabIds: [],
				ownedTabIds: [9],
				abandonedTabIds: [9],
			}),
		);
		await flush();
		expect(fixture.ext.messages.filter(message => message.t === "rpc" && message.op === "removeTab")).toHaveLength(2);
		fixture.bridge.extMessage(fixture.ext, JSON.stringify({ t: "tabRemoved", tabId: 9 }));
		fixture.reply("removeTab");
		await flush();
		expect(fixture.bridge.listTargets()).toEqual([]);
	});
});

describe("owned-create arbitration capability compatibility", () => {
	it.each([undefined, 2])(
		"refuses owned creation without the supported extension capability (%s), but still borrows tabs",
		async protocol => {
			const fixture = bridgeFixture({ protocol });
			fixture.request(1, "Target.createTarget");
			await flush();
			expect(fixture.driver.messages.find(message => message.id === 1)?.error).toMatchObject({
				message: expect.stringContaining("Reinstall"),
			});
			expect(fixture.ext.messages.filter(message => message.t === "rpc" && message.op === "createTab")).toEqual([]);
			fixture.request(2, "Target.attachToTarget");
			await flush();
			fixture.reply("attach");
			await flush();
			const sessionId = fixture.driver.messages.find(message => message.id === 2)?.result?.sessionId;
			expect(sessionId).toBeString();
			fixture.request(3, "OMP.claimTarget", sessionId);
			await flush();
			expect(fixture.driver.messages.find(message => message.id === 3)?.result).toEqual({});
		},
	);

	it("refuses create in the shipped new extension when the relay never acknowledges the capability", async () => {
		const fixture = await extensionFixture({ dropHelloAck: true });
		expect(fixture.creatorSocket.messages.find(message => message.id === 1)?.error).toMatchObject({
			message: expect.stringContaining("Update the omp browser relay"),
		});
		expect(fixture.createCalls()).toBe(0);
		expect(fixture.removed).toEqual([]);
		expect(fixture.bridge.listTargets()).toEqual([]);
	});
});

// Socket ordering controls adapted from the independent review reproducer.
async function handshakeFixture(blockHello = false, pending: number[] = []) {
	const sockets: Socket[] = [];
	const timers: Array<() => void> = [];
	let creates = 0;
	const queryGate = Promise.withResolvers<void>();
	if (!blockHello) queryGate.resolve();
	const stored: Record<string, unknown> = { relayBrowserSession: "run-1", ompAbandonedTabIds: pending };
	const event = { addListener() {} };
	class Socket {
		static OPEN = 1;
		static CONNECTING = 0;
		readyState = 1;
		onopen?: () => void;
		onclose?: () => void;
		onmessage?: (event: { data: string }) => void;
		messages: Record<string, unknown>[] = [];
		constructor() {
			sockets.push(this);
		}
		send(raw: string) {
			this.messages.push(JSON.parse(raw));
		}
		close() {
			this.readyState = 3;
			this.onclose?.();
		}
		message(value: object) {
			this.onmessage?.({ data: JSON.stringify(value) });
		}
	}
	const chrome = {
		tabs: {
			async query() {
				await queryGate.promise;
				return [];
			},
			async create() {
				creates++;
				return { id: 9, url: "about:blank", windowId: 44 };
			},
			async get() {
				return { id: 9, url: "about:blank", windowId: 44 };
			},
			async remove() {},
			onCreated: event,
			onRemoved: event,
			onUpdated: event,
			onActivated: event,
		},
		windows: {
			async getAll() {
				return [{ id: 44, state: "normal", focused: true }];
			},
		},
		storage: {
			local: {
				async get(defaults: object) {
					return { ...defaults, relayInstanceId: "browser" };
				},
				async set() {},
			},
			session: {
				async get(defaults: object) {
					return { ...defaults, ...stored };
				},
				async set(values: object) {
					Object.assign(stored, values);
				},
			},
			onChanged: event,
		},
		debugger: {
			async getTargets() {
				return [];
			},
			onEvent: event,
			onDetach: event,
		},
		tabGroups: {
			async query() {
				return [];
			},
		},
		alarms: { create() {}, onAlarm: event },
		action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, onClicked: event },
		runtime: { onInstalled: event, onStartup: event },
	};
	const bundle = await Bun.file(
		new URL("../../src/tools/browser/relay/extension-assets/background.js.txt", import.meta.url),
	).text();
	vm.runInNewContext(bundle, {
		chrome,
		WebSocket: Socket,
		AbortSignal,
		navigator: { userAgent: "Chrome/151" },
		fetch: async () => ({}),
		setTimeout: (fn: () => void) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
	});
	await flush();
	return { sockets, timers, queryGate, stored, creates: () => creates };
}
it("refuses an ack delivered before this socket has sent hello", async () => {
	const f = await handshakeFixture(true);
	const s = f.sockets[0]!;
	s.onopen?.();
	await flush();
	expect(s.messages.some(m => m.t === "hello")).toBe(false);
	s.message({ t: "helloAck", abandonedTabsProtocol: 1 });
	s.message({ t: "rpc", id: 1, op: "createTab", url: "about:blank" });
	await flush();
	f.queryGate.resolve();
	await flush();
	expect(f.creates()).toBe(0);
	expect(s.messages.find(m => m.t === "rpcResult" && m.id === 1)?.ok).toBe(false);
});
it("refuses stale-socket creates after replacement but before the new ack", async () => {
	const f = await handshakeFixture();
	const old = f.sockets[0]!;
	old.onopen?.();
	await flush();
	old.message({ t: "helloAck", abandonedTabsProtocol: 1 });
	old.close();
	f.timers.shift()!();
	await flush();
	const fresh = f.sockets[1]!;
	fresh.onopen?.();
	await flush();
	expect(fresh.messages.some(m => m.t === "hello")).toBe(true);
	old.message({ t: "rpc", id: 2, op: "createTab", url: "about:blank" });
	await flush();
	expect(f.creates()).toBe(0);
});
it("ignores an old-socket ack and allows only the new socket's valid post-hello ack", async () => {
	const f = await handshakeFixture();
	const old = f.sockets[0]!;
	old.onopen?.();
	await flush();
	old.message({ t: "helloAck", abandonedTabsProtocol: 1 });
	old.close();
	f.timers.shift()!();
	await flush();
	const fresh = f.sockets[1]!;
	fresh.onopen?.();
	await flush();
	old.message({ t: "helloAck", abandonedTabsProtocol: 1 });
	fresh.message({ t: "rpc", id: 3, op: "createTab", url: "about:blank" });
	await flush();
	expect(f.creates()).toBe(0);
	fresh.message({ t: "helloAck", abandonedTabsProtocol: 999 });
	fresh.message({ t: "rpc", id: 4, op: "createTab", url: "about:blank" });
	await flush();
	expect(f.creates()).toBe(0);
	fresh.message({ t: "helloAck", abandonedTabsProtocol: 1 });
	fresh.message({ t: "rpc", id: 5, op: "createTab", url: "about:blank" });
	await flush();
	expect(f.creates()).toBe(1);
	expect(fresh.messages.find(m => m.t === "rpcResult" && m.id === 5)?.ok).toBe(true);
});

it("retains a pending abandoned create when its acknowledgment arrives before hello", async () => {
	const f = await handshakeFixture(true, [9]);
	const socket = f.sockets[0]!;
	socket.onopen?.();
	await flush();
	socket.message({ t: "abandonedTabHandled", tabId: 9 });
	await flush();
	expect(f.stored.ompAbandonedTabIds).toEqual([9]);
	f.queryGate.resolve();
	await flush();
	socket.message({ t: "abandonedTabHandled", tabId: 9 });
	await flush();
	expect(f.stored.ompAbandonedTabIds).toEqual([]);
});
