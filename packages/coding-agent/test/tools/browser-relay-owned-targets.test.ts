import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import { closeRelayTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/owned-targets";
import type { RelayToExtMessage } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

const WS_ENDPOINT = "ws://relay.test/cdp";

/** Exercise the real bridge without a browser or listening socket. */
function connectOwnedTab(bridge: RelayBridge): { extension: RelaySocket; removed: number[]; targetId: string } {
	const removed: number[] = [];
	const extension: RelaySocket = {
		send(raw) {
			const request = JSON.parse(raw) as RelayToExtMessage;
			if (request.t !== "rpc" || request.op !== "removeTab") return;
			removed.push(request.tabId);
			queueMicrotask(() => {
				bridge.extMessage(extension, JSON.stringify({ t: "tabRemoved", tabId: request.tabId }));
				bridge.extMessage(extension, JSON.stringify({ t: "rpcResult", id: request.id, ok: true, result: {} }));
			});
		},
		close() {},
	};
	bridge.extConnected(extension);
	bridge.extMessage(
		extension,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			discardedTabsProtocol: 1,
			tabs: [
				{
					tabId: 9,
					url: "https://example.com/",
					title: "Owned",
					active: false,
					discarded: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			],
			attachedTabIds: [],
			ownedTabIds: [9],
		}),
	);
	const targetId = bridge.listTargets()[0]?.id;
	if (!targetId) throw new Error("Owned tab was not discoverable after the extension hello");
	return { extension, removed, targetId };
}

function installRelayTransport(bridge: RelayBridge, mapReply: (raw: string) => string = raw => raw): void {
	class RelayWebSocket {
		onopen: (() => void) | null = null;
		onmessage: ((event: { data: string }) => void) | null = null;
		onerror: (() => void) | null = null;
		onclose: (() => void) | null = null;
		readonly #connId: number;
		#closed = false;

		constructor() {
			this.#connId = bridge.cdpConnected({
				send: raw => queueMicrotask(() => this.onmessage?.({ data: mapReply(raw) })),
				close: () => this.close(),
			});
			queueMicrotask(() => this.onopen?.());
		}

		send(raw: string): void {
			bridge.cdpMessage(this.#connId, raw);
		}

		close(): void {
			if (this.#closed) return;
			this.#closed = true;
			bridge.cdpClosed(this.#connId);
			queueMicrotask(() => this.onclose?.());
		}
	}

	// Bun's spy types describe callable functions, including mocked constructors.
	const globals = globalThis as unknown as { WebSocket: () => WebSocket };
	spyOn(globals, "WebSocket").mockImplementation(() => new RelayWebSocket() as unknown as WebSocket);
}

afterEach(() => vi.restoreAllMocks());

describe("relay owned-target close confirmation", () => {
	it("confirms closure when the extension removes the requested tab", async () => {
		const bridge = new RelayBridge({});
		const { removed, targetId } = connectOwnedTab(bridge);
		installRelayTransport(bridge);

		expect(await closeRelayTarget(WS_ENDPOINT, targetId)).toBe(true);
		expect(removed).toEqual([9]);
		expect(bridge.listTargets()).toEqual([]);
	});

	it("keeps an offline target unresolved even though discovery hides it, allowing a later retry", async () => {
		const bridge = new RelayBridge({});
		const { extension, removed, targetId } = connectOwnedTab(bridge);
		installRelayTransport(bridge);
		bridge.extClosed(extension);
		expect(bridge.listTargets()).toEqual([]);

		expect(await closeRelayTarget(WS_ENDPOINT, targetId)).toBe(false);
		expect(removed).toEqual([]);

		const reconnected = connectOwnedTab(bridge);
		expect(await closeRelayTarget(WS_ENDPOINT, targetId)).toBe(true);
		expect(reconnected.removed).toEqual([9]);
	});

	it.each([{ success: false }, {}])("does not confirm an absent target after a close reply of %j", async result => {
		const bridge = new RelayBridge({});
		const { targetId } = connectOwnedTab(bridge);
		installRelayTransport(bridge, raw => {
			const reply = JSON.parse(raw) as { id?: number; result?: { success?: boolean } };
			return reply.result?.success === true ? JSON.stringify({ id: reply.id, result }) : raw;
		});

		expect(await closeRelayTarget(WS_ENDPOINT, targetId)).toBe(false);
		expect(bridge.listTargets()).toEqual([]);
	});
});
