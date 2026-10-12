import { describe, expect, test } from "bun:test";
import {
	connectedViewportFixture,
	reportViewportDiagnostic,
	viewportDiagnosticLine,
	VIEWPORT_OUTPUT_LIMIT,
	VIEWPORT_RECORD_LIMIT,
} from "./connected-viewport-diagnostics";

function payload(line: string): Record<string, any> {
	return JSON.parse(line.slice(line.indexOf("{")));
}

function fixtureScope() {
	const listeners = new Map<string, (() => void)[]>();
	const add = (name: string, fn: () => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]);
	const root = { clientWidth: 900, clientHeight: 556, scrollWidth: 900, scrollHeight: 556 };
	const document = { documentElement: root, addEventListener: add };
	const visualViewport = {
		width: 900,
		height: 556,
		scale: 1,
		offsetLeft: 0,
		offsetTop: 0,
		addEventListener: (name: string, fn: () => void) => add(`visual-${name}`, fn),
	};
	const scope: Record<string, any> = {
		document,
		innerWidth: 900,
		innerHeight: 556,
		devicePixelRatio: 2,
		outerWidth: 900,
		outerHeight: 700,
		performance: { timeOrigin: 1000, now: () => 10 },
		visualViewport,
		addEventListener: add,
	};
	scope.window = scope;
	scope.globalThis = scope;
	const html = decodeURIComponent(connectedViewportFixture().slice("data:text/html,".length));
	const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
	new Function("scope", `with (scope) { ${script} }`)(scope);
	return { scope, root, listeners, html };
}

describe("connected viewport passive diagnostics", () => {
	test("executes the actual fixture script with no visible body, timers, frame waits or getter changes", () => {
		const { scope, html } = fixtureScope();
		expect(html.startsWith("<title>Viewport</title><script>")).toBe(true);
		expect(html).not.toMatch(/<body|setTimeout|setInterval|requestAnimationFrame|defineProperty|setViewport/);
		expect(scope.__ompConnectedViewportTrace.samples).toHaveLength(1);
		expect(scope.__ompConnectedViewportTrace.samples[0]).toMatchObject({
			phase: "document-script",
			height: 556,
		});
	});

	test("records actual before/after fixture heights without converting 556 into 557", () => {
		const { scope, listeners } = fixtureScope();
		scope.innerHeight = 557;
		listeners.get("resize")?.forEach(fn => fn());
		const value = payload(
			viewportDiagnosticLine({
				openViewport: { width: 900, height: 556, deviceScaleFactor: 2 },
				runDiagnostics: {
					observed: { width: 900, height: 557, deviceScaleFactor: 2 },
					window: { width: 900, height: 557, deviceScaleFactor: 2 },
					diagnostic: { measured: { trace: scope.__ompConnectedViewportTrace } },
				},
			}),
		);
		expect(value.openViewport.height).toBe(556);
		expect(value.observed.height).toBe(557);
		expect(value.window.height).toBe(557);
		expect(value.samples.map((entry: any) => entry.height)).toEqual([556, 557]);
		expect(value.readySampleSource).toBe("unknown-test-cannot-observe-fallback");
	});

	test("bounds the fixture record count and explicitly reports dropped events", () => {
		const { scope, listeners } = fixtureScope();
		for (let i = 0; i < 100; i++) listeners.get("resize")?.forEach(fn => fn());
		expect(scope.__ompConnectedViewportTrace.samples).toHaveLength(VIEWPORT_RECORD_LIMIT);
		expect(scope.__ompConnectedViewportTrace.dropped).toBe(101 - VIEWPORT_RECORD_LIMIT);
	});

	test("fixture metric read failures remain diagnostics rather than uncaught event failures", () => {
		const { scope, root, listeners } = fixtureScope();
		// Only the mock fixture object is changed; browser/native getters are never patched.
		Object.defineProperty(root, "clientHeight", {
			get() {
				throw new Error("mock read failure");
			},
		});
		expect(() => listeners.get("resize")?.forEach(fn => fn())).not.toThrow();
		expect(scope.__ompConnectedViewportTrace.readErrors).toBe(1);
	});

	test("copies only allowlisted events and numeric fields and marks missing or invalid fields unknown", () => {
		const evil = {
			phase: "private content",
			height: Infinity,
			width: "private",
			url: "secret",
			toJSON() {
				throw new Error("raw toJSON must not run");
			},
		};
		const line = viewportDiagnosticLine({
			targetId: "private content",
			openViewport: evil,
			runDiagnostics: { diagnostic: { measured: { trace: { samples: [evil] } } } },
		});
		const value = payload(line);
		expect(line).not.toMatch(/private content|secret/);
		expect(value.targetId).toBe("unknown");
		expect(value.openViewport.height).toBe("unknown");
		expect(value.samples[0].phase).toBe("unknown");
	});

	test("bounds total UTF-8 output, record count and phase count, marking truncation", () => {
		const { scope } = fixtureScope();
		const sample = scope.__ompConnectedViewportTrace.samples[0];
		const line = viewportDiagnosticLine({
			phases: Array.from({ length: 100 }, () => ({ phase: "before-open" })),
			runDiagnostics: {
				diagnostic: {
					measured: { trace: { samples: Array.from({ length: 1000 }, () => sample) } },
				},
			},
		});
		const value = payload(line);
		expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(VIEWPORT_OUTPUT_LIMIT);
		expect(value.samples.length).toBeLessThanOrEqual(VIEWPORT_RECORD_LIMIT);
		expect(value.phases.length).toBe(4);
		expect(value.truncated).toBe(true);
		expect(value.omittedSamples).toBeGreaterThanOrEqual(1000 - VIEWPORT_RECORD_LIMIT);
	});

	test("read and serialization failures produce bounded explicit unknown evidence", () => {
		const unreadable = {
			get phases() {
				throw new Error("read");
			},
		};
		for (const line of [
			viewportDiagnosticLine(unreadable),
			viewportDiagnosticLine({}, () => {
				throw new Error("JSON");
			}),
		]) {
			expect(payload(line).status).toBe("diagnostic-read-or-serialization-failed");
			expect(payload(line).readySampleSource).toBe("unknown");
			expect(line.length).toBeLessThanOrEqual(VIEWPORT_OUTPUT_LIMIT);
		}
		expect(payload(viewportDiagnosticLine({}, () => "x".repeat(VIEWPORT_OUTPUT_LIMIT + 1))).status).toBe("truncated");
	});

	test("a real exact assertion failure survives failed diagnostic reads and logging and still cleans up", () => {
		let primary: unknown;
		let caught: unknown;
		let cleaned = false;
		try {
			try {
				expect({ height: 556 }).toEqual({ height: 557 });
			} catch (error) {
				primary = error;
				reportViewportDiagnostic(
					{
						get phases() {
							throw new Error("read");
						},
					},
					() => {
						throw new Error("log");
					},
				);
				throw error;
			} finally {
				cleaned = true;
			}
		} catch (error) {
			caught = error;
		}
		expect(primary).toBeDefined();
		expect(caught).toBe(primary);
		expect(cleaned).toBe(true);
	});
});
