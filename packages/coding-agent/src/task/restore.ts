/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn ({@link hasRestorableTurn}), was not killed (no
 * tombstone) and can be revived (a `session_init` contract, not isolated) runs one
 * more monitored turn as a background job of its parent: the lifecycle reviver
 * rebuilds it from its transcript, {@link runSubagentFollowUpTurn} goes on with the
 * cut-off turn and drives it to `yield`, and the parent receives the result as the
 * ordinary `async-result` of a job with the subagent's id, the id its first run's
 * job had, so a parent waiting on that job finds it again.
 */
import * as path from "node:path";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { AsyncJobError } from "../async";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { hasRestorableTurn } from "../session/exit-diagnostics";
import { extractSessionInit, type PersistedSessionInit } from "../session/session-manager";
import type { SessionEntry } from "../session/session-entries";
import { collectSubSessions, type SubSession } from "../session/sub-sessions";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn } from "./executor";
import { persistedAgentDefinition } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";

/** Where restored subagents' lifecycle and progress frames go, as a live run's do. */
export interface RestoreOptions {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/** What `omp --restore` went on with. */
export interface RestoreOutcome {
	/** The session's own interrupted turn goes on. */
	turn: boolean;
	/** Ids of the subagents that go on with theirs, parents before their children. */
	subagents: string[];
}

/**
 * Has `session` go on with what its last process left unfinished: its subagents'
 * interrupted turns, each as a background job of its parent (registered first, so
 * a resumed turn waiting on such a job finds it), then its own interrupted turn.
 */
export async function restoreSession(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	// Main already has a sink: a fast child must not wake it before its own
	// interrupted tool batch has retried. Streaming delivery remains available.
	const releaseIdle = session.yieldQueue.holdIdleFlush();
	try {
		const subagents = await restoreSubagents(session, options);
		const turn = await session.restoreInterruptedTurn();
		if (turn) {
			void session
				.waitForIdle()
				.catch(error => {
					logger.warn("Restored root turn did not settle cleanly", { error: String(error) });
				})
				.finally(releaseIdle);
		} else releaseIdle();
		return { turn, subagents };
	} catch (error) {
		releaseIdle();
		throw error;
	}
}

/** Inspect only the selected ancestry; abandoned siblings must not decide whether a turn resumes. */
function selectedBranchEntries(sub: SubSession): SessionEntry[] {
	const byId = new Map(sub.entries.map(entry => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let id = sub.leafId;
	while (id !== null) {
		const entry = byId.get(id);
		// A broken ancestry is not authority to execute a persisted turn.
		if (!entry || seen.has(id)) return [];
		seen.add(id);
		branch.push(entry);
		id = entry.parentId;
	}
	return branch.reverse();
}

/**
 * Has every subagent of `session` that its last process left mid-turn go on with that
 * turn (see the module docs). Nothing is restored for a session without a file, or
 * without background jobs (the `async.enabled` setting off), which could not deliver
 * the results.
 */
async function restoreSubagents(session: AgentSession, options: RestoreOptions): Promise<string[]> {
	const sessionFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	if (!sessionFile || !manager) return [];
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const subSessions = await collectSubSessions(sessionFile, key => {
		logger.warn("Subagent transcript unreadable; not restored", { key });
	});
	// Parents first: a child's result is delivered to its parent's session.
	const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
	const candidates = new Map<string, { ref: AgentRef; init: PersistedSessionInit }>();
	for (const key of keys) {
		const sub = subSessions[key]!;
		const ref = registry.get(sub.agentId);
		const init = extractSessionInit(sub.entries);
		const ownerId = sub.parent ? subSessions[sub.parent]?.agentId : (session.getAgentId?.() ?? MAIN_AGENT_ID);
		if (
			sub.aborted ||
			!ref?.sessionFile ||
			ref.kind !== "sub" ||
			ref.status === "aborted" ||
			!init ||
			init.isolated ||
			ref.parentId !== ownerId ||
			path.resolve(ref.sessionFile) !== path.resolve(sessionFile.slice(0, -6), `${key}.jsonl`)
		)
			continue;
		// A missing, killed, isolated, or replaced ancestor is not an alternate
		// route to Main. Leave its entire subtree transcript-only.
		if (sub.parent && !candidates.has(sub.parent)) continue;
		candidates.set(key, { ref, init });
	}
	const interrupted = keys.filter(
		key => candidates.has(key) && hasRestorableTurn(selectedBranchEntries(subSessions[key]!)),
	);
	const ownerKeys = new Set<string>();
	for (const key of interrupted) {
		for (let parent = subSessions[key]!.parent; parent; parent = subSessions[parent]!.parent) ownerKeys.add(parent);
	}
	// A terminal assistant/yield can still be waiting at the executor's
	// quiescence barrier. Rebuild that owner as a monitored coordinator too;
	// restore:true leaves its completed prompt untouched and observes only
	// the descendant results once its queued job is admitted.
	const scheduled = keys.filter(key => interrupted.includes(key) || ownerKeys.has(key));
	const lifecycle = AgentLifecycleManager.global();
	const owners = new Map<string, { session: AgentSession; release: () => void; releaseIdle?: () => void }>();
	const unavailable = new Set<string>();
	const restored: string[] = [];
	const jobs: Promise<void>[] = [];
	try {
		for (const key of keys) {
			if (!ownerKeys.has(key)) continue;
			const { ref } = candidates.get(key)!;
			const parent = subSessions[key]!.parent;
			if (parent && unavailable.has(parent)) {
				unavailable.add(key);
				continue;
			}
			let release: (() => void) | undefined;
			try {
				release = lifecycle.hold(ref.id, ref);
				const live = await lifecycle.ensureLive(ref.id);
				if (registry.get(ref.id) !== ref || ref.session !== live || live.asyncJobManager !== manager) {
					throw new Error("Restored owner changed session generation");
				}
				const releaseIdle = !manager.getJob(ref.id) ? live.yieldQueue.holdIdleFlush() : undefined;
				owners.set(key, { session: live, release, releaseIdle });
			} catch (error) {
				release?.();
				unavailable.add(key);
				logger.warn("Subagent owner cannot be revived; subtree not restored", { id: ref.id, error: String(error) });
			}
		}
		for (const key of scheduled) {
			const { ref, init } = candidates.get(key)!;
			const id = ref.id;
			const parent = subSessions[key]!.parent;
			if (unavailable.has(key) || (parent && unavailable.has(parent)) || manager.getJob(id)) continue;
			const sessionFileOfRef = ref.sessionFile!;
			const structured = init.tools.includes("yield");
			manager.register(
				"task",
				id,
				async ({ signal }) => {
					for (let current: string | null = key; current; current = subSessions[current]!.parent) {
						const expected = candidates.get(current)!.ref;
						if (registry.get(expected.id) !== expected || expected.status === "aborted") {
							// A stale tree may not send even an error into a replacement
							// owner's sink. Preserve the cancelled row for inspection.
							manager.cancel(id);
							throw new Error(`Subagent "${id}" changed before restore execution`);
						}
					}
					// Acquire only after admission, for this exact generation. A leaf needs
					// the same TTL protection as owners while its restored turn is settling.
					const release = lifecycle.hold(id, ref);
					try {
						const result = await runSubagentFollowUpTurn({
							id,
							agent: persistedAgentDefinition(ref.displayName, init),
							message: init.task,
							restore: true,
							onRestoreSettled: owners.get(key)?.releaseIdle,
							structured,
							workPoolYieldItems: init.workPoolYieldItems,
							outputSchema: init.outputSchema,
							outputSchemaMode: init.outputSchemaMode,
							signal,
							eventBus: options.eventBus,
							subagentEventBus: options.subagentEventBus,
							artifactsDir: path.dirname(sessionFileOfRef),
							maxRuntimeMs: cfgTaskMaxRuntimeMs.get(session.settings),
						});
						const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
						const structuredOutput = result.structuredOutput;
						if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
							throw new AsyncJobError(text, structuredOutput);
						}
						return structuredOutput ? { text, structured: structuredOutput } : text;
					} finally {
						release();
					}
				},
				{
					id,
					agentId: id,
					ownerId: ref.parentId,
					waitForCapacity: true,
					// Queued parents hold no slot while their descendants finish. The
					// manager publishes the entire batch before this scan can begin.
					beforeStart: signal =>
						untilAborted(signal, async () => {
							await manager.waitForOwnerJobs(id, { excludeSuppressed: true });
							// If every child was cancelled/consumed, a terminal owner has
							// no result to integrate and must not get a fresh yield reminder.
							if (!interrupted.includes(key) && !owners.get(key)!.session.hasPendingAsyncWork()) {
								manager.cancel(id);
							}
						}),
				},
			);
			const job = manager.getJob(id)!;
			const cancelChildren = () => {
				if (registry.get(id) === ref) manager.cancelAll({ ownerId: id }, job.abortController.signal.reason);
			};
			job.abortController.signal.addEventListener("abort", cancelChildren, { once: true });
			jobs.push(job.promise);
			void job.promise.finally(() => {
				job.abortController.signal.removeEventListener("abort", cancelChildren);
				owners.get(key)?.releaseIdle?.();
			});
			restored.push(id);
		}
	} finally {
		// Keep each owner alive through delivery acknowledgement and the resulting
		// wake turn. Deepest owners settle first so their yielded results can travel
		// through their restored job to the next ancestor, without replaying
		// any completed ancestor's task prompt. Explicit kill/disposal still wins.
		void Promise.all(jobs)
			.then(async () => {
				// Cancelled queued jobs never reach the executor callback. Release their
				// idle holds too, before waiting on the corresponding delivery receipts.
				for (const owner of owners.values()) owner.releaseIdle?.();
				for (const key of [...keys].reverse()) {
					const owner = owners.get(key);
					if (!owner) continue;
					try {
						await owner.session.settleAsyncWork();
					} catch (error) {
						logger.warn("Restored owner wake settlement failed", { key, error: String(error) });
					}
					// One failed/aborted wake must not release another owner's lease
					// while that owner's delivery receipt is still outstanding.
					await manager.drainDeliveries({ filter: { ownerId: candidates.get(key)!.ref.id } });
				}
			})
			.catch(error => {
				logger.warn("Restored subagent delivery settlement failed", { error: String(error) });
			})
			.finally(() => {
				for (const owner of owners.values()) {
					owner.releaseIdle?.();
					owner.release();
				}
			});
	}
	if (restored.length > 0) logger.info("Restored interrupted subagents", { ids: restored });
	return restored;
}
