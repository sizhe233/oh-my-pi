/** A debugger target is a tab, optionally scoped to a flat child session. */
export interface CaptureTarget {
	tabId: number;
	sessionId?: string;
}

type CommandResult = Record<string, unknown> | undefined;
type SendCommand = (
	target: CaptureTarget,
	method: string,
	params?: Record<string, unknown>,
) => Promise<CommandResult>;

interface CaptureState {
	target: CaptureTarget;
	queue: Promise<unknown>;
	owner?: "temporary" | "recording";
	temporaryActive: boolean;
	detached: boolean;
}

/**
 * A minimized headed Chrome window can stall captureScreenshot even when JS
 * and animation frames are running. A temporary screencast wakes rendering
 * without restoring the window. Serialize only capture/cast lifecycle commands;
 * frame ACKs and unrelated CDP commands must remain free to run.
 */
export class ScreenshotCapture {
	#states = new Map<string, CaptureState>();

	constructor(
		private readonly sendCommand: SendCommand,
		private readonly isMinimized: (tabId: number) => Promise<boolean>,
	) {}

	#key(target: CaptureTarget): string {
		return `${target.tabId}:${target.sessionId ?? ""}`;
	}

	send(target: CaptureTarget, method: string, params?: Record<string, unknown>): Promise<CommandResult> {
		if (method !== "Page.captureScreenshot" && method !== "Page.startScreencast" && method !== "Page.stopScreencast") {
			return this.sendCommand(target, method, params);
		}
		const key = this.#key(target);
		let state = this.#states.get(key);
		if (!state) {
			state = { target, queue: Promise.resolve(), temporaryActive: false, detached: false };
			this.#states.set(key, state);
		}
		const current = state;
		const result = current.queue.then(() => this.#run(current, method, params));
		current.queue = result.catch(() => {});
		return result;
	}

	async #stopTemporary(state: CaptureState): Promise<void> {
		if (!state.temporaryActive || state.detached) return;
		await this.sendCommand(state.target, "Page.stopScreencast");
		state.temporaryActive = false;
		// Retain temporary ownership for late frames, until an explicit start.
	}

	async #run(state: CaptureState, method: string, params?: Record<string, unknown>): Promise<CommandResult> {
		if (state.detached) throw new Error("Screenshot target detached");
		// Retry a failed cleanup before allowing another lifecycle operation.
		await this.#stopTemporary(state);
		if (state.detached) throw new Error("Screenshot target detached");
		if (method === "Page.startScreencast") {
			const previousOwner = state.owner;
			state.owner = "recording";
			try {
				return await this.sendCommand(state.target, method, params);
			} catch (error) {
				state.owner = previousOwner;
				throw error;
			}
		}
		if (method === "Page.stopScreencast") {
			const result = await this.sendCommand(state.target, method, params);
			if (state.owner === "recording") state.owner = undefined;
			return result;
		}
		if (state.owner === "recording" || !(await this.isMinimized(state.target.tabId))) {
			if (state.detached) throw new Error("Screenshot target detached");
			return await this.sendCommand(state.target, method, params);
		}
		if (state.detached) throw new Error("Screenshot target detached");
		state.owner = "temporary";
		state.temporaryActive = true;
		try {
			await this.sendCommand(state.target, "Page.startScreencast", { format: "png", everyNthFrame: 1 });
			if (state.detached) throw new Error("Screenshot target detached");
			return await this.sendCommand(state.target, method, params);
		} finally {
			await this.#stopTemporary(state);
		}
	}

	/** Consume and ACK only frames owned by our render wake, never recording frames. */
	handleEvent(target: CaptureTarget, method: string, params?: Record<string, unknown>): boolean {
		if (method !== "Page.screencastFrame" || this.#states.get(this.#key(target))?.owner !== "temporary") {
			return false;
		}
		if (typeof params?.sessionId === "number") {
			void this.sendCommand(target, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
		}
		return true;
	}

	/** Detachment destroys screencasts; queued work must not run on a reattached target. */
	detach(target: CaptureTarget): void {
		for (const [key, state] of this.#states) {
			if (state.target.tabId !== target.tabId) continue;
			if (target.sessionId !== undefined && state.target.sessionId !== target.sessionId) continue;
			state.detached = true;
			this.#states.delete(key);
		}
	}
}
