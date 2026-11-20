/**
 * Target cleanup for omp-created relay tabs.
 *
 * The relay exposes no browser target, so puppeteer's `browser.target()`
 * throws and the generic CDP-session close path cannot reach it. Root-level
 * commands go over a short-lived websocket to the relay's CDP endpoint instead.
 *
 * Tabs omp creates through the relay are recorded in the durable
 * orphan registry (keyed by relay endpoint, under the machine-global relay
 * runtime dir) so a later omp process can close them once their creator has
 * died without running its own cleanup (crash, TerminateProcess, SIGKILL).
 */
import { createHash } from "node:crypto";
import { daemonDir } from "../../../daemon/paths";
import type { SharedTargetScope } from "../orphan-registry";

const ROOT_COMMAND_TIMEOUT_MS = 5_000;

/** Durable-ownership scope for omp-created tabs behind one relay endpoint. */
export function relayTargetScope(cdpUrl: string): SharedTargetScope {
	const runtimeDir = daemonDir();
	const url = new URL(cdpUrl);
	// Include origin and discovery path; never put endpoint credentials in the filename.
	const endpoint = createHash("sha256").update(url.origin + url.pathname + url.search).digest("hex").slice(0, 32);
	return { projectDir: runtimeDir, runtimeDir, daemonName: `omp.browser.relay-${endpoint}` };
}

/** Send one root-session CDP command to the relay and return its result; rejects on CDP error or timeout. */
async function sendRootCommand(
	wsEndpoint: string,
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const socket = new WebSocket(wsEndpoint);
	const timer = setTimeout(() => reject(new Error(`relay ${method} timed out`)), ROOT_COMMAND_TIMEOUT_MS);
	socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
	socket.onmessage = event => {
		let reply: unknown;
		try {
			reply = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (typeof reply !== "object" || reply === null || !("id" in reply) || reply.id !== 1) return;
		if ("error" in reply) {
			const error = reply.error;
			const message =
				typeof error === "object" && error !== null && "message" in error ? String(error.message) : "CDP error";
			reject(new Error(message));
			return;
		}
		const result = "result" in reply ? reply.result : undefined;
		resolve(typeof result === "object" && result !== null ? { ...result } : {});
	};
	socket.onerror = () => reject(new Error(`relay websocket failed during ${method}`));
	socket.onclose = () => reject(new Error(`relay websocket closed during ${method}`));
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		socket.close();
	}
}

/**
 * Close a relay tab this process created. True only when the relay confirms
 * the close. Discovery is filtered (including while an extension is offline),
 * so an absent target cannot prove closure or justify forgetting ownership.
 */
export async function closeRelayTarget(wsEndpoint: string, targetId: string): Promise<boolean> {
	try {
		const result = await sendRootCommand(wsEndpoint, "Target.closeTarget", { targetId });
		return result.success === true;
	} catch {
		return false;
	}
}

/**
 * Reaper close for a dead process's relay tab. The relay closes it only when
 * the extension created it in the current browser session and no live
 * connection drives it. True when the record is resolved (closed or stale);
 * false keeps it for a later retry (relay or its browser unreachable).
 */
export async function closeRelayOwnedTarget(wsEndpoint: string, targetId: string): Promise<boolean> {
	try {
		const result = await sendRootCommand(wsEndpoint, "OMP.closeOwnedTarget", { targetId });
		return result.resolved === true;
	} catch {
		return false;
	}
}
