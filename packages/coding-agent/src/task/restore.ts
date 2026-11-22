/**
 * Restore an interrupted session and its saved subagent tree. Jobs keep their
 * original ids and owner lineage; a completed ancestor only coordinates result
 * delivery, never replays its original task.
 */
import * as path from "node:path";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import {
	type AsyncJob,
	AsyncJobError,
	type AsyncJobManagerApi,
	type AsyncJobRunContext,
	type AsyncJobRunResult,
} from "../async";
import { AgentLifecycleManager, type AgentLifecycleApi } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { hasRestorableTurn } from "../session/exit-diagnostics";
import { extractSessionInit, type PersistedSessionInit } from "../session/session-manager";
import { collectSubSessions } from "../session/sub-sessions";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import { persistedAgentDefinition, persistedAgentName } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";
import { readStepProgress, type StepProgress } from "./steps";

export interface RestoreOptions {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

export interface RestoreOutcome {
	turn: boolean;
	subagents: string[];
}

interface RestoreNode {
	readonly ref: AgentRef;
	readonly sessionFile: string;
	readonly ownerId: string;
	readonly init: PersistedSessionInit;
	readonly steps: StepProgress | undefined;
	readonly interrupted: boolean;
	readonly parent: RestoreNode | undefined;
	readonly children: RestoreNode[];
	readonly lifetime: AbortController;
	needed: boolean;
	row?: AsyncJob;
	owner?: RestoreOwner;
	target?: AgentSessionHandle;
	releaseLifetime?: () => void;
}

interface RestoreOwner {
	readonly id: string;
	readonly home: AgentSessionHandle;
	readonly token: string;
	readonly signal: AbortSignal;
	discard?: Promise<void>;
}

class RestoreTree {
	readonly #registry: AgentRegistryApi = AgentRegistry.global();
	readonly #lifecycle: AgentLifecycleApi = AgentLifecycleManager.global();
	readonly #rootId: string;
	readonly #rootRef: AgentRef | undefined;
	readonly #lifetime = new AbortController();
	readonly #ready = Promise.withResolvers<void>();
	readonly #byId = new Map<string, RestoreNode>();
	readonly #nodes: RestoreNode[] = [];
	readonly #owners: RestoreOwner[] = [];
	readonly #unsubscribe: () => void;
	readonly #onAbort: () => void;
	#rootOwner?: RestoreOwner;
	#rootRelease: Promise<void> = Promise.resolve();

	constructor(
		readonly root: AgentSession,
		readonly rootFile: string,
		readonly manager: AsyncJobManagerApi,
		readonly options: RestoreOptions,
	) {
		this.#rootId = root.getAgentId() ?? MAIN_AGENT_ID;
		this.#rootRef = this.#registry.get(this.#rootId);
		// A partial batch can be rejected before its first prepare subscribes.
		void this.#ready.promise.catch(() => {});
		this.#unsubscribe = this.#registry.onChange(({ ref }) => {
			if (ref.id === this.#rootId && !this.#rootCurrent()) this.cancel(new Error("Restore root changed"));
			const node = this.#byId.get(ref.id);
			if (node && !this.#nodeCurrent(node)) this.#invalidate(node, new Error("Restored agent changed"));
		});
		const lifetime = this.#lifetime;
		root.addDisposer(() => lifetime.abort(new Error("Restore root disposed")));
		this.#onAbort = () => {
			for (const node of this.#nodes) this.#invalidate(node, lifetime.signal.reason);
		};
		lifetime.signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	#rootCurrent(): boolean {
		const ref = this.#registry.get(this.#rootId);
		return (
			ref === this.#rootRef &&
			(!ref || (ref.status !== "aborted" && ref.session?.instanceKey === this.root.instanceKey)) &&
			this.root.sessionManager.getSessionFile() === this.rootFile &&
			this.root.asyncJobManager === this.manager
		);
	}

	#nodeCurrent(node: RestoreNode): boolean {
		const ref = this.#registry.get(node.ref.id);
		return (
			ref === node.ref &&
			ref.status !== "aborted" &&
			ref.parentId === node.ownerId &&
			ref.sessionFile === node.sessionFile &&
			(!node.target ||
				(ref.session?.instanceKey === node.target.instanceKey && ref.session.sessionFile === node.sessionFile))
		);
	}

	#invalidate(node: RestoreNode, reason: unknown): void {
		if (node.lifetime.signal.aborted) return;
		node.lifetime.abort(reason);
		for (const child of node.children) this.#invalidate(child, reason);
		const receipt = (node.parent ? node.parent.owner : this.#rootOwner)?.token;
		if (node.row && receipt) {
			this.manager.cancel(node.row.id, { ownerId: node.ownerId, restoreReceiptId: receipt });
		}
		if (node.owner) void this.#discard(node.owner);
	}

	#discard(owner: RestoreOwner): Promise<void> {
		owner.discard ??= owner.home.finishRestoreIdleHold(owner.token, true).then(
			() => {},
			error => {
				// A dead link aborts the imported lease signal at the home;
				// if the home itself died, its queue died with it.
				logger.debug("Restore discard could not reach owner home", { id: owner.id, error: String(error) });
			},
		);
		return owner.discard;
	}

	#assertRoot(): void {
		this.#lifetime.signal.throwIfAborted();
		if (this.#rootCurrent()) return;
		const error = new Error("Restore root changed");
		this.cancel(error);
		throw error;
	}

	#assertCurrent(node: RestoreNode): void {
		this.#assertRoot();
		for (const ancestor of this.#lineage(node)) {
			ancestor.lifetime.signal.throwIfAborted();
			if (this.#nodeCurrent(ancestor)) continue;
			const error = new Error("Restored agent changed: " + ancestor.ref.id);
			this.#invalidate(ancestor, error);
			throw error;
		}
	}

	*#lineage(node: RestoreNode): Iterable<RestoreNode> {
		for (let current: RestoreNode | undefined = node; current; current = current.parent) yield current;
	}

	cancel(reason: unknown): void {
		this.#lifetime.abort(reason);
		this.#ready.reject(reason);
	}

	/**
	 * Establish the owner homes before registering any descendant. Main owns
	 * admission; each session's home owns the idle gate and stamped receipt.
	 */
	async stage(): Promise<string[]> {
		this.#assertRoot();
		const token = await this.root.acquireRestoreIdleHold(this.rootFile, this.manager, this.#lifetime.signal);
		const rootOwner = { id: this.#rootId, home: this.root, token, signal: this.#lifetime.signal };
		this.#rootOwner = rootOwner;
		this.#owners.push(rootOwner);
		this.#assertRoot();

		await ensurePersistedRoster(this.#registry, this.rootFile);
		this.#assertRoot();
		const subSessions = await collectSubSessions(this.rootFile, {
			onUnreadable: key => logger.warn("Subagent transcript unreadable; not restored", { key }),
		});
		this.#assertRoot();
		const byKey = new Map<string, RestoreNode>();
		const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
		for (const key of keys) {
			const sub = subSessions[key]!;
			const ref = this.#registry.get(sub.agentId);
			const init = extractSessionInit(sub.entries);
			const parent = sub.parent ? byKey.get(sub.parent) : undefined;
			const ownerId = parent?.ref.id ?? this.#rootId;
			if (
				sub.aborted ||
				(sub.parent && !parent) ||
				!ref?.sessionFile ||
				ref.kind !== "sub" ||
				ref.status === "aborted" ||
				!init ||
				init.isolated ||
				ref.parentId !== ownerId ||
				path.resolve(ref.sessionFile) !== path.resolve(this.rootFile.slice(0, -6), key + ".jsonl") ||
				this.#byId.has(ref.id)
			) {
				continue;
			}
			const node: RestoreNode = {
				ref,
				sessionFile: ref.sessionFile,
				ownerId,
				init,
				steps: readStepProgress(sub.entries),
				interrupted: hasRestorableTurn(sub.entries),
				parent,
				children: [],
				lifetime: new AbortController(),
				needed: false,
			};
			byKey.set(key, node);
			this.#byId.set(ref.id, node);
			this.#nodes.push(node);
			parent?.children.push(node);
			if (node.interrupted) {
				for (const ancestor of this.#lineage(node)) ancestor.needed = true;
			}
		}

		for (const node of this.#nodes) {
			if (!node.needed || node.lifetime.signal.aborted) continue;
			if (this.manager.getJob(node.ref.id)) {
				this.#invalidate(node, new Error("Restored id already belongs to a live job"));
				continue;
			}
			try {
				this.#assertCurrent(node);
				node.releaseLifetime = this.#lifecycle.hold(node.ref.id, node.ref);
				if (!node.children.some(child => child.needed)) continue;
				const home = await this.#ensureTarget(node);
				const receipt = await home.acquireRestoreIdleHold(node.sessionFile, this.manager, node.lifetime.signal);
				node.owner = { id: node.ref.id, home, token: receipt, signal: node.lifetime.signal };
				this.#owners.push(node.owner);
				this.#assertCurrent(node);
			} catch (error) {
				this.#invalidate(node, error);
				logger.warn("Subagent owner cannot be restored; subtree left transcript-only", {
					id: node.ref.id,
					error: String(error),
				});
			}
		}

		this.#assertRoot();
		const ids: string[] = [];
		for (const node of this.#nodes) {
			if (!node.needed || node.lifetime.signal.aborted) continue;
			this.#assertCurrent(node);
			const receipt = node.parent ? node.parent.owner : rootOwner;
			if (!receipt) throw new Error("Nested restore has no matching owner home");
			const id = this.manager.register("task", node.ref.id, ctx => this.#run(node, ctx), {
				id: node.ref.id,
				agentId: node.ref.id,
				ownerId: node.ownerId,
				restoreReceiptId: receipt.token,
				waitForCapacity: true,
				beforeStart: signal => this.#prepare(node, signal),
			});
			const row = this.manager.getJob(id);
			if (!row || row.restoreReceiptId !== receipt.token) {
				this.manager.cancel(id, { ownerId: node.ownerId, restoreReceiptId: receipt.token });
				throw new Error("Restore registration did not acknowledge its exact row");
			}
			node.row = row;
			const onAbort = () => this.#invalidate(node, row.abortController.signal.reason);
			row.abortController.signal.addEventListener("abort", onAbort, { once: true });
			void row.promise
				.finally(() => row.abortController.signal.removeEventListener("abort", onAbort))
				.catch(() => {});
			if (row.abortController.signal.aborted) onAbort();
			ids.push(id);
		}
		// Remote registration ACKs one row at a time: a prepare can be invoked
		// before the last sibling exists. None can inspect descendants until here.
		this.#ready.resolve();
		return ids;
	}

	async #ensureTarget(node: RestoreNode): Promise<AgentSessionHandle> {
		this.#assertCurrent(node);
		const home = await this.#lifecycle.ensureLive(node.ref.id, node.ref);
		this.#assertCurrent(node);
		const live = this.#registry.get(node.ref.id)?.session;
		if (live?.instanceKey !== home.instanceKey || home.sessionFile !== node.sessionFile) {
			const error = new Error("Restored agent is no longer homed on its revived session");
			this.#invalidate(node, error);
			throw error;
		}
		node.target = home;
		return home;
	}

	async #prepare(node: RestoreNode, signal: AbortSignal): Promise<void> {
		await untilAborted(signal, this.#ready.promise);
		this.#assertCurrent(node);
		const children = node.children.flatMap(child => (child.row ? [child.row.promise] : []));
		await untilAborted(signal, () => Promise.all(children).then(() => {}));
		this.#assertCurrent(node);
		if (!node.interrupted) {
			const owner = node.owner;
			if (!owner) throw new Error("Restore coordinator has no owner home");
			const pending = await untilAborted(signal, () => owner.home.hasRestorePendingReceipt(owner.token));
			this.#assertCurrent(node);
			if (!pending) {
				// Completed coordinators must not be prodded to produce a fresh
				// yield if all saved descendant results were consumed or cancelled.
				const error = new Error("Restored coordinator has no pending descendant result");
				this.#invalidate(node, error);
				throw error;
			}
		}
	}

	async #run(node: RestoreNode, { signal, reportProgress }: AsyncJobRunContext): Promise<string | AsyncJobRunResult> {
		const { ref, init } = node;
		const lifetime = AbortSignal.any([signal, node.lifetime.signal, this.#lifetime.signal]);
		try {
			const target = node.target ?? (await untilAborted(lifetime, () => this.#ensureTarget(node)));
			this.#assertCurrent(node);
			lifetime.throwIfAborted();
			const owner = node.owner;
			const result = await runSubagentFollowUpTurn({
				id: ref.id,
				agent: persistedAgentDefinition(ref.displayName, init),
				message: init.task,
				restore: true,
				expectedRestoreTarget: {
					generation: ref.generation,
					parentId: node.ownerId,
					sessionFile: node.sessionFile,
					instanceKey: target.instanceKey,
				},
				reportRestoredStep: async text => {
					this.#assertCurrent(node);
					lifetime.throwIfAborted();
					await reportProgress(text);
					this.#assertCurrent(node);
				},
				onRestoreSettled:
					owner &&
					(async () => {
						try {
							this.#assertCurrent(node);
							await this.#release(owner);
							this.#assertCurrent(node);
							// Release ACK alone does not mean a receipt reached the sink.
							// A terminal coordinator had no initial run. Wait until its
							// receipt is committed before a step or reminder can start.
							await this.#drain(owner);
							this.#assertCurrent(node);
						} catch (error) {
							this.#invalidate(node, error);
							throw error;
						}
					}),
				steps: node.steps,
				workPoolYieldItems: init.workPoolYieldItems,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				signal: lifetime,
				eventBus: this.options.eventBus,
				subagentEventBus: this.options.subagentEventBus,
				artifactsDir: path.dirname(node.sessionFile),
				maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.root.settings),
				...softRequestBudgetFor(persistedAgentName(ref.displayName, init), this.root.settings),
			});
			this.#assertCurrent(node);
			lifetime.throwIfAborted();
			const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
			const structured = result.structuredOutput;
			if (result.aborted || result.exitCode !== 0 || result.error !== undefined)
				throw new AsyncJobError(text, structured);
			return structured ? { text, structured } : text;
		} catch (error) {
			// A stale generation must not publish an error into its replacement
			// either. assertCurrent cancels only its tagged rows.
			this.#assertCurrent(node);
			throw error;
		}
	}

	async #release(owner: RestoreOwner): Promise<void> {
		owner.signal.throwIfAborted();
		const released = await owner.home.releaseRestoreIdleHold(owner.token);
		owner.signal.throwIfAborted();
		if (!released) throw new Error("Restore owner did not acknowledge idle release: " + owner.id);
	}

	async #drain(owner: RestoreOwner): Promise<void> {
		const drained = await untilAborted(owner.signal, () =>
			this.manager.drainDeliveries({ filter: { ownerId: owner.id, restoreReceiptId: owner.token } }),
		);
		owner.signal.throwIfAborted();
		if (!drained) throw new Error("Restore owner delivery did not drain: " + owner.id);
	}

	async restoreRootTurn(): Promise<boolean> {
		this.#assertRoot();
		const owner = this.#rootOwner!;
		const boundary = Promise.withResolvers<void>();
		const unsubscribe = this.root.subscribe(event => {
			if (event.type === "agent_pause" || event.type === "agent_end") boundary.resolve();
		});
		try {
			const scheduled = await untilAborted(owner.signal, () => this.root.restoreInterruptedTurn());
			this.#assertRoot();
			if (!scheduled) {
				await this.#release(owner);
				unsubscribe();
			} else {
				// An abandoned run closes without agent_end. It is not permission
				// to release idle delivery into the next run or transcript.
				const firstBoundary = Promise.race([
					boundary.promise.then(() => true),
					this.root.waitForRunEnd().then(() => false),
				]);
				this.#rootRelease = untilAborted(owner.signal, firstBoundary)
					.then(async observed => {
						if (!observed) throw new Error("Restored root run was abandoned before its loop boundary");
						this.#assertRoot();
						await this.#release(owner);
						this.#assertRoot();
					})
					.catch(error => {
						this.cancel(error);
						throw error;
					})
					.finally(unsubscribe);
				void this.#rootRelease.catch(() => {});
			}
			return scheduled;
		} catch (error) {
			unsubscribe();
			throw error;
		}
	}

	async finish(): Promise<void> {
		try {
			await untilAborted(this.#lifetime.signal, () =>
				Promise.all(this.#nodes.flatMap(node => (node.row ? [node.row.promise] : []))).then(() => {}),
			);
			await this.#rootRelease;
			for (const owner of [...this.#owners].reverse()) {
				const node = this.#byId.get(owner.id);
				try {
					if (node) this.#assertCurrent(node);
					else this.#assertRoot();
					await this.#release(owner);
					await this.#drain(owner);
					await untilAborted(owner.signal, () => owner.home.waitForRunEnd());
					if (node) this.#assertCurrent(node);
					else this.#assertRoot();
					if (!(await owner.home.finishRestoreIdleHold(owner.token, false))) {
						throw new Error("Restore home did not acknowledge receipt completion");
					}
				} catch (error) {
					if (node) this.#invalidate(node, error);
					else this.cancel(error);
					await this.#discard(owner);
					logger.warn("Restored owner settlement failed", { id: owner.id, error: String(error) });
				}
			}
		} catch (error) {
			this.cancel(error);
			await Promise.all(this.#owners.map(owner => this.#discard(owner)));
			logger.debug("Restore batch did not settle", { error: String(error) });
		} finally {
			this.#unsubscribe();
			this.#lifetime.signal.removeEventListener("abort", this.#onAbort);
			for (const node of this.#nodes) node.releaseLifetime?.();
		}
	}
}

export async function restoreSession(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	const sessionFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	if (!sessionFile || !manager) return { turn: await session.restoreInterruptedTurn(), subagents: [] };
	const tree = new RestoreTree(session, sessionFile, manager, options);
	try {
		const subagents = await tree.stage();
		const turn = await tree.restoreRootTurn();
		void tree.finish();
		if (subagents.length > 0) logger.info("Restored interrupted subagents", { ids: subagents });
		return { turn, subagents };
	} catch (error) {
		tree.cancel(error);
		await tree.finish();
		throw error;
	}
}
