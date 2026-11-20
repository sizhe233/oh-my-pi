import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<{ worker: SubagentWorker; probe: AgentsProbe }> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, asyncJobsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return { worker, probe: await probe.promise };
}

/**
 * Poll a condition fed by another thread (mirror patches, worker-side state).
 * There is no in-process clock to fake across a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function liveRef(id: string): AgentRef {
	const ref = AgentRegistry.global().get(id);
	if (!ref) throw new Error(`no ref ${id}`);
	return ref;
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker session mirror");
	return session;
}

async function mainSession(id: string): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
	});
	return session;
}

describe("agent bridging across subagent workers", () => {
	it("mirrors a real worker-homed AgentSession on main: streaming, run state, events, messages", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { gated: true });
		const ref = liveRef("W1");
		const remote = mirrorOf(ref.session);
		expect(remote.instanceKey).toBe(key);
		expect(remote.home).toBe(worker.threadId);
		expect(key.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(worker.load).toBe(1);

		const runStates: string[] = [];
		remote.subscribeRunState(state => runStates.push(state));
		const events: string[] = [];
		remote.subscribe(event => events.push(event.type));

		const prompting = remote.prompt("hello from main");
		await waitFor(() => remote.isStreaming && ref.status === "running");
		expect(remote.runStartedAt).toBeNumber();

		await probe.openGate();
		expect(await prompting).toBe(true);
		await waitFor(() => !remote.isStreaming && ref.status === "idle");
		const roles = remote.messages.map(message => message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(remote.agent.state.messages).toBe(remote.messages);
		expect(remote.getSessionStats().assistantMessages).toBeGreaterThan(0);
		expect(runStates).toEqual(["running", "idle"]);
		expect(events).toContain("agent_end");
	});

	it("republishes the message mirror after a history rewrite that keeps both endpoints", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await waitFor(() => remote.messages.length >= 4);

		// Pruning rebuilds the runtime history with new interior content but the same first/last objects.
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");

		await waitFor(() => remote.messages.length >= 6);
		const interior = remote.messages[1];
		expect(interior?.role === "assistant" ? interior.content : undefined).toEqual([{ type: "text", text: "pruned" }]);
	});

	it("fails a worker's registry CAS against a stale main ref generation", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const before = await probe.grab("W1");
		const registry = AgentRegistry.global();
		const replaced = registry.register({
			id: "W1",
			displayName: "W1",
			kind: "sub",
			session: liveRef("W1").session,
			status: "idle",
		});
		expect(replaced.generation).not.toBe(before);

		expect(await probe.cas("W1", "running")).toEqual({ grabbed: false, fresh: true, canonical: true });
		expect(registry.get("W1")?.status).toBe("running");
		expect(await probe.manages()).toBe(true);
	});

	it("lets a worker read a main-homed session through one canonical peer handle", async () => {
		const { probe } = await startWorker();
		const main = await mainSession("Main");
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: main,
			status: "running",
		});

		const report = await probe.peer("Main");
		expect(report).toEqual({
			isPeer: true,
			key: main.instanceKey,
			isStreaming: false,
			messageCount: 0,
			sessionFile: undefined,
			canonical: true,
			casBySession: true,
		});
		expect(liveRef("Main").status).toBe("idle");

		await probe.peerSubscribe("Main");
		expect(await probe.peerPrompt("Main", "hello from a worker")).toEqual({ accepted: true });
		expect(main.messages.map(message => message.role)).toContain("assistant");
		await waitFor(async () => {
			const seen = await probe.peerSeen();
			return seen.events.includes("agent_end") && seen.runStates.includes("idle");
		});
		expect((await probe.peerSeen()).runStates).toEqual(["running", "idle"]);
	});

	it("delivers an IRC message from main into a worker-homed session", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);

		const receipt = await IrcBus.global().send({ from: "Main", to: "W1", body: "ping from main" });
		expect(["injected", "woken"]).toContain(receipt.outcome);
		await waitFor(async () => (await probe.localCustomTypes("W1")).includes("irc:incoming"));
		await waitFor(() =>
			remote.messages.some(message => message.role === "custom" && message.customType === "irc:incoming"),
		);
	});

	it("routes a restore lease between distinct worker homes and cleans up only its receipts on caller loss", async () => {
		const manager = new AsyncJobManager({});
		const wrongManager = new AsyncJobManager({});
		cleanups.push(
			() => manager.dispose({ timeoutMs: 1000 }),
			() => wrongManager.dispose({ timeoutMs: 1000 }),
		);
		const caller = await startWorker();
		// This worker is only a caller, with no resident session of its own.
		// Keep its test link alive until the fixture explicitly kills it.
		cleanups.push(caller.worker.retain());
		const home = await startWorker();
		const owner = "RestoreOwner";
		const other = "ForeignOwner";
		const ownerFile = path.join(os.tmpdir(), "agent-bridge-" + Bun.randomUUIDv7() + ".jsonl");
		const foreignFile = ownerFile + ".foreign";
		const key = await home.probe.open(owner, { sessionFile: ownerFile, manager });
		await home.probe.open(other, { sessionFile: foreignFile, manager });
		const mirror = mirrorOf(liveRef(owner).session);
		const peer = await caller.probe.peer(owner);
		expect(peer.isPeer).toBe(true);
		expect(peer.key).toBe(key);
		expect(peer.canonical).toBe(true);
		expect(peer.sessionFile).toBe(ownerFile);
		expect(mirror.home).toBe(home.worker.threadId);
		expect(home.worker.threadId).not.toBe(caller.worker.threadId);
		expect(await caller.probe.threadId()).toBe(caller.worker.threadId);

		async function expectRpcRejection(pending: Promise<unknown>, message: string): Promise<void> {
			const deadline = Promise.withResolvers<never>();
			const timeout = setTimeout(() => deadline.reject(new Error("No timely RPC rejection")), 10_000);
			try {
				const error = await Promise.race([pending, deadline.promise]).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(error instanceof Error ? error.message : String(error)).toContain(message);
			} finally {
				clearTimeout(timeout);
			}
		}
		await expectRpcRejection(
			caller.probe.peerAcquireRestore(owner, ownerFile, wrongManager),
			"Restore owner home changed",
		);
		await expectRpcRejection(
			caller.probe.peerAcquireRestore(owner, foreignFile, manager),
			"Restore owner home changed",
		);
		const token = await caller.probe.peerAcquireRestore(owner, ownerFile, manager);
		expect(token.startsWith(key + ":")).toBe(true);
		await expectRpcRejection(
			caller.probe.peerAcquireRestore(owner, ownerFile, manager),
			"already has a restore lease",
		);
		expect(await caller.probe.peerReleaseRestore(other, token)).toBe(false);
		expect(await caller.probe.peerFinishRestore(other, token, true)).toBe(false);

		const complete = async (id: string, ownerId: string, text: string, restoreReceiptId?: string) => {
			const key = manager.register("task", id, async () => text, { id, ownerId, restoreReceiptId });
			await manager.getJob(key)?.promise;
		};
		await complete("first-restored-receipt", owner, "first-owner-restored-marker", token);
		await complete("foreign-restored-receipt", other, "foreign-restored-marker", token);
		expect(await caller.probe.peerRestorePending(owner, token)).toBe(true);
		expect(await home.probe.localCustomTypes(owner)).not.toContain("async-result");
		await expectRpcRejection(caller.probe.peerFinishRestore(owner, token, false), "outstanding scoped delivery");
		expect(await caller.probe.peerReleaseRestore(owner, token)).toBe(true);
		expect(await manager.drainDeliveries({ timeoutMs: 5000 })).toBe(true);
		await mirror.waitForRunEnd();
		await waitFor(() => JSON.stringify(mirror.messages).includes("first-owner-restored-marker"));
		expect(await home.probe.localCustomTypes(other)).not.toContain("async-result");
		expect(await caller.probe.peerFinishRestore(owner, token, false)).toBe(true);
		expect(await caller.probe.peerReleaseRestore(owner, token)).toBe(false);

		const next = await caller.probe.peerAcquireRestore(owner, ownerFile, manager);
		expect(next).not.toBe(token);
		await complete("interrupted-restored-receipt", owner, "interrupted-owner-marker", next);
		await complete("ordinary-receipt", owner, "ordinary-owner-marker");
		expect(await caller.probe.peerRestorePending(owner, next)).toBe(true);
		expect((await home.probe.localCustomTypes(owner)).filter(type => type === "async-result")).toHaveLength(1);
		caller.worker.terminate("restore caller lost");
		expect(await manager.drainDeliveries({ timeoutMs: 5000 })).toBe(true);
		await mirror.waitForRunEnd();
		await waitFor(() => JSON.stringify(mirror.messages).includes("ordinary-owner-marker"));
		expect(JSON.stringify(mirror.messages)).not.toContain("interrupted-owner-marker");
		expect(home.worker.alive).toBe(true);
		expect(mirror.closed).toBe(false);

		expect(await mirror.releaseRestoreIdleHold(next)).toBe(false);
		const final = await mirror.acquireRestoreIdleHold(ownerFile, manager, new AbortController().signal);
		expect(final).not.toBe(next);
		expect(await mirror.finishRestoreIdleHold(final, true)).toBe(true);
	}, 60_000);

	it("detaches refs and rejects in-flight commands when the worker dies", async () => {
		const { worker, probe } = await startWorker();
		await probe.open("Parked", { sessionFile: "/tmp/agents-bridge-parked.jsonl", gated: true });
		await probe.open("Lost", {});
		await probe.adopt("Parked");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("Parked"));
		const parked = liveRef("Parked");
		const lost = liveRef("Lost");
		const remote = mirrorOf(parked.session);

		const pending = remote.prompt("never answered");
		await waitFor(() => remote.isStreaming);
		worker.terminate("killed by test");

		await expect(pending).rejects.toThrow(worker.threadId);
		expect(remote.closed).toBe(true);
		expect(parked.session).toBeNull();
		expect(parked.status).toBe("parked");
		expect(lost.session).toBeNull();
		expect(lost.status).toBe("aborted");
		// The adoption (and its release hook) survives; only the dead worker's warm reviver is gone.
		expect(lifecycle.has("Parked")).toBe(true);
		await expect(lifecycle.ensureLive("Parked")).rejects.toThrow("no reviver registered");
		await expect(remote.prompt("again")).rejects.toThrow(worker.threadId);
		await remote.dispose();
	});

	it("parks a worker-homed session and warm-revives it through the worker's reviver", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { sessionFile: "/tmp/agents-bridge-revive.jsonl" });
		await probe.adopt("W1");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("W1"));
		const ref = liveRef("W1");
		const first = mirrorOf(ref.session);

		await lifecycle.park("W1");
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(first.closed).toBe(true);
		expect(await probe.disposed(key)).toBe(true);

		const revived = mirrorOf(await lifecycle.ensureLive("W1"));
		expect(revived).not.toBe(first);
		expect(revived.instanceKey.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(liveRef("W1").session).toBe(revived);
		expect(liveRef("W1").status).toBe("idle");
		expect(worker.load).toBe(1);
	});
});
