/** Run the actual extension worker with process-local Chrome and transport doubles. */
import { FakeWebSocket, probe } from "./browser-relay-background-stubs";
import "../../../browser-relay/extension/background";

async function settle(): Promise<void> {
	for (let tick = 0; tick < 40; tick++) await Promise.resolve();
}

await settle();
const socket = probe.sockets[0];
if (!socket) throw new Error("Extension did not dial the fake relay");
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
await settle();

probe.listeners.tabsCreated[0](probe.borrowed);
const event = probe.listeners.debuggerOnEvent[0];
event({ tabId: probe.borrowed.id }, "Page.loadEventFired", {});
event({ tabId: probe.borrowed.id }, "Page.downloadWillBegin", { guid: "synthetic" });
event({ tabId: probe.borrowed.id }, "Browser.downloadProgress", { filePath: "/fixture/not-shared" });
function rpc(id: number, request: Record<string, unknown>): void {
	socket.onmessage?.({ data: JSON.stringify({ t: "rpc", id, ...request }) });
}
rpc(1, { op: "findDownload", guid: "synthetic" });
rpc(2, { op: "createTab", url: "about:blank" });
await settle();
const afterCreate = probe.session.ompCreatedTabIds;
probe.listeners.tabsRemoved[0](probe.owned.id);
await settle();
const afterRemoval = probe.session.ompCreatedTabIds;
rpc(3, { op: "createTab", url: "about:blank#late" });
await settle();
socket.close();
probe.lateCreate.resolve({ ...probe.borrowed, id: 10 });
await settle();

console.log(JSON.stringify({
	urls: probe.sockets.map(candidate => candidate.url),
	preflights: probe.preflights,
	sent: probe.sent,
	blockedApiReads: probe.blockedApiReads,
	createCalls: probe.createCalls,
	afterCreate,
	afterRemoval,
	removed: probe.removed,
}));
