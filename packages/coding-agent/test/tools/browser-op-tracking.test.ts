import { describe, expect, it } from "bun:test";
import { captureScreenshotBuffer } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import {
	describeInflight,
	describeScreenshot,
	type InflightOp,
	preparePageForScreenshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";

type ScreenshotPage = Parameters<typeof preparePageForScreenshot>[0];
type CapturePage = Parameters<typeof captureScreenshotBuffer>[0];

describe("browser op tracking — timeout diagnostics", () => {
	it("labels a screenshot op by its distinguishing argument", () => {
		expect(describeScreenshot({ selector: ".wb-paper-popover" })).toBe(
			'tab.screenshot({ selector: ".wb-paper-popover" })',
		);
		expect(describeScreenshot({ fullPage: true })).toBe("tab.screenshot({ fullPage: true })");
		expect(describeScreenshot()).toBe("tab.screenshot()");
		expect(describeScreenshot({})).toBe("tab.screenshot()");
	});

	it("names every still-running helper so a cell timeout is attributable", () => {
		const now = Date.now();
		// Inserted newest-first to prove the summary sorts by start time, not insertion order.
		const inflight = new Map<number, InflightOp>([
			[1, { label: "tab.observe()", startedAt: now - 1_000 }],
			[0, { label: 'tab.screenshot({ selector: ".x" })', startedAt: now - 3_000 }],
		]);

		const summary = describeInflight(inflight);

		// Oldest op (most likely the culprit) is listed first.
		expect(summary.indexOf("tab.screenshot")).toBeLessThan(summary.indexOf("tab.observe"));
		// Each op carries an elapsed-seconds annotation.
		expect(summary).toMatch(/tab\.screenshot\(\{ selector: "\.x" \}\) \(\d+\.\d+s\)/);
		expect(summary).toMatch(/tab\.observe\(\) \(\d+\.\d+s\)/);
	});

	it("returns an empty summary when nothing is in flight", () => {
		expect(describeInflight(new Map())).toBe("");
	});
});

describe("browser screenshot activation", () => {
	it("activates owned targets before capture", async () => {
		let activations = 0;
		const page = {
			bringToFront: async () => {
				activations += 1;
			},
			evaluate: async () => {
				throw new Error("visibility should not be queried");
			},
		};

		await preparePageForScreenshot(page as ScreenshotPage, undefined, true);

		expect(activations).toBe(1);
	});

	it("leaves a visible user-driven target in place", async () => {
		let activations = 0;
		const page = {
			bringToFront: async () => {
				activations += 1;
			},
			evaluate: async () => true,
		};

		await preparePageForScreenshot(page as ScreenshotPage, undefined, false);

		expect(activations).toBe(0);
	});

	it("rejects a background user-driven target instead of capturing sibling pixels", async () => {
		const page = {
			bringToFront: async () => undefined,
			evaluate: async () => false,
		};

		await expect(preparePageForScreenshot(page as ScreenshotPage, undefined, false)).rejects.toThrow(
			"The attached browser tab is not visible",
		);
	});
});

describe("browser screenshot capture", () => {
	it("captures a tab whose animation frames never run (minimized Chrome window)", async () => {
		let captures = 0;
		const png = new Uint8Array([137, 80, 78, 71]);
		const page = {
			// A minimized window never services requestAnimationFrame.
			evaluate: () => new Promise<never>(() => {}),
			screenshot: async () => {
				captures += 1;
				return png;
			},
		};

		const started = performance.now();
		const result = await captureScreenshotBuffer(page as unknown as CapturePage, {}, undefined, async () => null);

		expect(result).toBe(png);
		expect(captures).toBe(1);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("still aborts when the caller cancels during the frame wait", async () => {
		const controller = new AbortController();
		const page = {
			evaluate: () => new Promise<never>(() => {}),
			screenshot: async () => new Uint8Array(),
		};
		const capture = captureScreenshotBuffer(page as unknown as CapturePage, {}, controller.signal, async () => null);
		controller.abort(new Error("cancelled"));

		await expect(capture).rejects.toThrow("cancelled");
	});
});
