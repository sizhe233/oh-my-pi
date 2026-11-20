import { expect, it } from "bun:test";

const PROBE = `${import.meta.dir}/browser-relay-background-probe.ts`;

interface Frame {
	t: string;
	[key: string]: unknown;
}

interface ProbeReport {
	urls: string[];
	preflights: string[];
	sent: Frame[];
	blockedApiReads: string[];
	createCalls: Array<Record<string, unknown>>;
	afterCreate: number[];
	afterRemoval: number[];
	removed: number[];
}

function runProbe(trap: boolean, emptySession = false): ProbeReport {
	const proc = Bun.spawnSync([process.execPath, PROBE], {
		env: { ...Bun.env, PROBE_PERMISSION_TRAP: trap ? "1" : "0", PROBE_EMPTY_SESSION: emptySession ? "1" : "0" },
		timeout: 5_000,
	});
	expect(proc.exitCode, proc.stderr.toString()).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

it.each([
	{ scenario: "permissions absent", trap: false },
	{ scenario: "restricted APIs exposed by a stale manifest", trap: true },
])("starts without restricted browser capabilities ($scenario)", ({ trap }) => {
	const { preflights, urls, sent, blockedApiReads } = runProbe(trap);
	expect(preflights).toEqual(["http://127.0.0.1:9224/json/version"]);
	expect(urls).toEqual(["ws://127.0.0.1:9224/ext"]);
	expect(blockedApiReads).toEqual([]);
	const hello = sent.find(frame => frame.t === "hello");
	expect(hello).toMatchObject({ browserSession: "fixture-run", ownedTabIds: [7] });
	expect(hello).not.toHaveProperty("downloadsProtocol");
	expect(sent.find(frame => frame.t === "tabCreated")).toMatchObject({ tab: { tabId: 5 } });
	expect(sent.filter(frame => frame.t === "cdpEvent")).toEqual([
		{ t: "cdpEvent", tabId: 5, method: "Page.loadEventFired", params: {} },
	]);
	expect(sent.find(frame => frame.t === "rpcResult" && frame.id === 1)).toMatchObject({ ok: false });
});

it("records only relay-created tabs and bounds late cleanup to the created tab", () => {
	const { afterCreate, afterRemoval, createCalls, removed, sent } = runProbe(true);
	expect(createCalls).toEqual([
		{ url: "about:blank", active: false, windowId: 1 },
		{ url: "about:blank#late", active: false, windowId: 1 },
	]);
	expect(afterCreate).toEqual([7, 9]);
	expect(afterRemoval).toEqual([9]);
	expect(removed).toEqual([10]);
	expect(sent.find(frame => frame.t === "rpcResult" && frame.id === 2)).toMatchObject({ ok: true });
	expect(sent.find(frame => frame.t === "rpcResult" && frame.id === 3)).toBeUndefined();
});

it("does not recover prior ownership when the browser's session storage is cleared", () => {
	const { sent, afterCreate } = runProbe(false, true);
	const hello = sent.find(frame => frame.t === "hello");
	expect(hello?.browserSession).toEqual(expect.any(String));
	expect(hello?.browserSession).not.toBe("fixture-run");
	expect(hello?.ownedTabIds).toEqual([]);
	expect(afterCreate).toEqual([9]);
});
