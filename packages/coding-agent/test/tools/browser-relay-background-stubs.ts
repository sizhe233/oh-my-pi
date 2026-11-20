/** Synthetic Chrome and relay transport; no actual network or browser is used. */
type Listener = (...args: unknown[]) => void;

const borrowed = { id: 5, url: "https://example.invalid/", active: true, windowId: 1, pinned: false, groupId: -1 };
const owned = { ...borrowed, id: 7 };
const session: Record<string, unknown> = Bun.env.PROBE_EMPTY_SESSION === "1"
	? {}
	: { relayBrowserSession: "fixture-run", ompCreatedTabIds: [owned.id] };

export const probe = {
	borrowed,
	owned,
	session,
	lateCreate: Promise.withResolvers<typeof borrowed>(),
	listeners: {} as Record<string, Listener[]>,
	sockets: [] as FakeWebSocket[],
	sent: [] as Array<Record<string, unknown>>,
	preflights: [] as string[],
	blockedApiReads: [] as string[],
	createCalls: [] as Record<string, unknown>[],
	removed: [] as number[],
};

export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readonly url: string;
	constructor(url: string) {
		this.url = url;
		probe.sockets.push(this);
	}
	close(): void {
		this.readyState = 3;
	}
	send(data: string): void {
		probe.sent.push(JSON.parse(data));
	}
}

const event = (name: string) => ({
	addListener(callback: Listener): void {
		(probe.listeners[name] ??= []).push(callback);
	},
});

const globals = globalThis as Record<string, unknown>;
// The worker's ping timer would keep the probe process alive; the probe never needs it to fire.
globals.setInterval = () => 0;
globals.clearInterval = () => {};
globals.WebSocket = FakeWebSocket;
globals.fetch = async (input: string): Promise<Response> => {
	probe.preflights.push(input);
	return new Response();
};
const chromeStub = {
	runtime: {
		id: "a".repeat(32),
		reload() {},
		openOptionsPage: async () => {},
		onInstalled: event("runtimeOnInstalled"),
		onStartup: event("runtimeOnStartup"),
	},
	action: {
		onClicked: event("actionClicked"),
		setBadgeText: async () => {},
		setBadgeBackgroundColor: async () => {},
	},
	storage: {
		local: { get: async (defaults: Record<string, unknown>) => ({ ...defaults }), set: async () => {} },
		session: {
			get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...session }),
			set: async (values: Record<string, unknown>) => {
				Object.assign(session, values);
			},
		},
		onChanged: event("storageChanged"),
	},
	alarms: { create() {}, onAlarm: event("alarm") },
	tabs: {
		onCreated: event("tabsCreated"),
		onUpdated: event("tabsUpdated"),
		onActivated: event("tabsActivated"),
		onRemoved: event("tabsRemoved"),
		query: async () => [borrowed, owned],
		create: async (options: Record<string, unknown>) => {
			probe.createCalls.push(options);
			if (options.url === "about:blank#late") return await probe.lateCreate.promise;
			return { ...borrowed, id: 9 };
		},
		remove: async (id: number) => {
			probe.removed.push(id);
		},
		get: async (id: number) => ({ id }),
	},
	windows: { getAll: async () => [{ id: 1, state: "minimized" }] },
	debugger: {
		onEvent: event("debuggerOnEvent"),
		onDetach: event("debuggerOnDetach"),
		getTargets: async () => [],
	},
};
if (Bun.env.PROBE_PERMISSION_TRAP === "1") {
	for (const name of ["downloads", "scripting"]) {
		Object.defineProperty(chromeStub, name, {
			get() {
				probe.blockedApiReads.push(name);
				throw new Error("Unexpected restricted Chrome API read");
			},
		});
	}
}
globals.chrome = chromeStub;
