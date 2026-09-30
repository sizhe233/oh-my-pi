import { describe, expect, test } from "bun:test";
import { type CaptureTarget, ScreenshotCapture } from "../extension/screenshot-capture";

const target: CaptureTarget = { tabId: 7 };
const start = "Page.startScreencast";
const capture = "Page.captureScreenshot";
const stop = "Page.stopScreencast";
const frame = "Page.screencastFrame";
const ack = "Page.screencastFrameAck";

interface Command {
	target: CaptureTarget;
	method: string;
	params?: Record<string, unknown>;
}

function harness(minimized = true) {
	const commands: Command[] = [];
	const checks: number[] = [];
	const hooks = {
		send: async (_command: Command): Promise<Record<string, unknown> | undefined> => ({ data: "real screenshot" }),
	};
	const coordinator = new ScreenshotCapture(
		async (target, method, params) => {
			const command = { target, method, params };
			commands.push(command);
			return await hooks.send(command);
		},
		async tabId => {
			checks.push(tabId);
			return minimized;
		},
	);
	return { coordinator, commands, checks, hooks, methods: () => commands.map(command => command.method) };
}

describe("minimized screenshot render wake", () => {
	test("brackets the original capture and returns its unmodified result", async () => {
		const h = harness();
		const params = { format: "jpeg", quality: 80, captureBeyondViewport: false };
		expect(await h.coordinator.send(target, capture, params)).toEqual({ data: "real screenshot" });
		expect(h.methods()).toEqual([start, capture, stop]);
		expect(h.commands).toEqual([
			{ target, method: start, params: { format: "png", everyNthFrame: 1 } },
			{ target, method: capture, params },
			{ target, method: stop, params: undefined },
		]);
		expect(h.checks).toEqual([7]);
	});

	test("visible windows take the normal capture path", async () => {
		const h = harness(false);
		await h.coordinator.send(target, capture);
		expect(h.methods()).toEqual([capture]);
	});

	test("an existing recording is untouched and its frames are forwarded", async () => {
		const h = harness();
		const recording = { format: "jpeg", quality: 42, everyNthFrame: 3 };
		await h.coordinator.send(target, start, recording);
		await h.coordinator.send(target, capture);
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 1 })).toBe(false);
		expect(h.methods()).toEqual([start, capture]);
		expect(h.commands[0]?.params).toEqual(recording);
		expect(h.checks).toEqual([]);
		await h.coordinator.send(target, stop);
		await h.coordinator.send(target, capture);
		expect(h.methods()).toEqual([start, capture, stop, start, capture, stop]);
	});

	test("concurrent screenshots and recording lifecycle cannot interleave", async () => {
		const h = harness();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.hooks.send = async command => {
			if (command.method === capture) {
				started.resolve();
				await release.promise;
			}
			return {};
		};
		const first = h.coordinator.send(target, capture);
		await started.promise;
		const second = h.coordinator.send(target, capture);
		const recording = h.coordinator.send(target, start, { format: "jpeg" });
		const duringRecording = h.coordinator.send(target, capture);
		const stopped = h.coordinator.send(target, stop);
		await h.coordinator.send(target, "Runtime.evaluate", { expression: "1" });
		expect(h.methods()).toEqual([start, capture, "Runtime.evaluate"]);
		release.resolve();
		await Promise.all([first, second, recording, duringRecording, stopped]);
		expect(h.methods()).toEqual([
			start,
			capture,
			"Runtime.evaluate",
			stop,
			start,
			capture,
			stop,
			start,
			capture,
			stop,
		]);
	});

	test("ACKs temporary frames even before start resolves and after stop, without blocking the queue", async () => {
		const h = harness();
		h.hooks.send = async command => {
			if (command.method === start || command.method === capture || command.method === stop) {
				expect(h.coordinator.handleEvent(target, frame, { sessionId: 31 })).toBe(true);
			}
			return {};
		};
		await h.coordinator.send(target, capture);
		expect(h.methods()).toEqual([start, ack, capture, ack, stop, ack]);
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 32 })).toBe(true);
		expect(h.commands.at(-1)).toEqual({ target, method: ack, params: { sessionId: 32 } });
		expect(h.coordinator.handleEvent(target, "Page.loadEventFired", {})).toBe(false);
		h.hooks.send = async command => {
			if (command.method === start) expect(h.coordinator.handleEvent(target, frame, { sessionId: 33 })).toBe(false);
			return {};
		};
		await h.coordinator.send(target, start);
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 34 })).toBe(false);
	});

	test.each([start, capture])("cleans up a failed %s and recovers its queue", async failingMethod => {
		const h = harness();
		h.hooks.send = async command => {
			if (command.method === failingMethod) throw new Error("injected failure");
			return {};
		};
		await expect(h.coordinator.send(target, capture)).rejects.toThrow("injected failure");
		expect(h.methods().at(-1)).toBe(stop);
		h.hooks.send = async () => ({});
		await h.coordinator.send(target, capture);
		expect(h.methods().slice(-3)).toEqual([start, capture, stop]);
	});

	test("retries failed cleanup before starting a recording and retains temporary frame ownership", async () => {
		const h = harness();
		h.hooks.send = async command => {
			if (command.method === stop) throw new Error("stop failed");
			return {};
		};
		await expect(h.coordinator.send(target, capture)).rejects.toThrow("stop failed");
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 9 })).toBe(true);
		h.hooks.send = async () => ({});
		await h.coordinator.send(target, start);
		expect(h.methods()).toEqual([start, capture, stop, ack, stop, start]);
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 10 })).toBe(false);
	});

	test("failed explicit lifecycle commands do not discard recording ownership", async () => {
		const h = harness();
		await h.coordinator.send(target, start);
		h.hooks.send = async command => {
			if (command.method === start || command.method === stop) throw new Error("failed");
			return {};
		};
		await expect(h.coordinator.send(target, stop)).rejects.toThrow("failed");
		await expect(h.coordinator.send(target, start)).rejects.toThrow("failed");
		await h.coordinator.send(target, capture);
		expect(h.methods()).toEqual([start, stop, start, capture]);
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 1 })).toBe(false);
	});

	test("different tabs and flat sessions have independent queues and ownership", async () => {
		const h = harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.hooks.send = async command => {
			if (command.target === target && command.method === capture) {
				entered.resolve();
				await release.promise;
			}
			return {};
		};
		const pending = h.coordinator.send(target, capture);
		await entered.promise;
		for (const other of [{ tabId: 8 }, { tabId: 7, sessionId: "child" }]) {
			await h.coordinator.send(other, start);
			await h.coordinator.send(other, capture);
			expect(h.coordinator.handleEvent(other, frame, { sessionId: 1 })).toBe(false);
		}
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 2 })).toBe(true);
		release.resolve();
		await pending;
	});

	test("detach discards ownership and prevents queued work or cleanup on a new attachment", async () => {
		const h = harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.hooks.send = async command => {
			if (command.method === capture) {
				entered.resolve();
				await release.promise;
			}
			return {};
		};
		const pending = h.coordinator.send(target, capture);
		await entered.promise;
		const queued = h.coordinator.send(target, capture);
		h.coordinator.detach(target);
		expect(h.coordinator.handleEvent(target, frame, { sessionId: 3 })).toBe(false);
		await h.coordinator.send(target, start);
		release.resolve();
		await pending;
		await expect(queued).rejects.toThrow("detached");
		expect(h.methods()).toEqual([start, capture, start]);
	});
});
