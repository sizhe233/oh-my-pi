/** Test-local, passive geometry evidence. No production/browser globals are patched. */
export const VIEWPORT_RECORD_LIMIT = 16;
export const VIEWPORT_OUTPUT_LIMIT = 8192;
const PREFIX = "[connected-viewport-diagnostic] ";
const SAMPLE_PHASES = new Set([
	"document-script",
	"window-resize",
	"visual-viewport-resize",
	"dom-content-loaded",
	"load",
]);
const HOST_PHASES = new Set(["before-open", "after-open", "before-run", "after-run"]);
const UNKNOWN = "unknown";

/** Only this test's blank data document receives the recorder; it creates no visible body. */
export function connectedViewportFixture(): string {
	return `data:text/html,${encodeURIComponent(`<title>Viewport</title><script>
(() => {
  const trace = { timeOrigin: null, samples: [], dropped: 0, readErrors: 0 };
  try {
  const record = phase => {
    if (trace.samples.length >= ${VIEWPORT_RECORD_LIMIT}) { trace.dropped += 1; return; }
    try {
      const root = document.documentElement;
      const visual = window.visualViewport;
      trace.samples.push({
        phase, at: performance.now(), wallMs: Date.now(),
        width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
        outerWidth, outerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
        visual: visual ? { width: visual.width, height: visual.height, scale: visual.scale,
          offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop } : null,
      });
    } catch { trace.readErrors += 1; }
  };
  globalThis.__ompConnectedViewportTrace = trace;
  trace.timeOrigin = performance.timeOrigin;
  record("document-script");
  window.addEventListener("resize", () => record("window-resize"));
  window.visualViewport?.addEventListener("resize", () => record("visual-viewport-resize"));
  document.addEventListener("DOMContentLoaded", () => record("dom-content-loaded"), { once: true });
  window.addEventListener("load", () => record("load"), { once: true });
  } catch { trace.readErrors += 1; }
})();
</script>`)}`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | typeof UNKNOWN {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15 ? value : UNKNOWN;
}

function dimensions(value: unknown): Record<string, number | typeof UNKNOWN> {
	const source = record(value);
	return {
		width: number(source.width),
		height: number(source.height),
		deviceScaleFactor: number(source.deviceScaleFactor),
	};
}

function sample(value: unknown): Record<string, unknown> {
	const source = record(value);
	const visual = record(source.visual);
	return {
		phase: typeof source.phase === "string" && SAMPLE_PHASES.has(source.phase) ? source.phase : UNKNOWN,
		at: number(source.at),
		wallMs: number(source.wallMs),
		...dimensions(source),
		outerWidth: number(source.outerWidth),
		outerHeight: number(source.outerHeight),
		clientWidth: number(source.clientWidth),
		clientHeight: number(source.clientHeight),
		scrollWidth: number(source.scrollWidth),
		scrollHeight: number(source.scrollHeight),
		visual: {
			width: number(visual.width),
			height: number(visual.height),
			scale: number(visual.scale),
			offsetLeft: number(visual.offsetLeft),
			offsetTop: number(visual.offsetTop),
		},
	};
}

/** All values are copied through an allowlist before JSON; raw page values/toJSON never escape. */
export function viewportDiagnosticLine(input: unknown, stringify: (value: unknown) => string = JSON.stringify): string {
	try {
		const source = record(input);
		const run = record(source.runDiagnostics);
		const diagnostic = record(run.diagnostic);
		const measured = record(diagnostic.measured);
		const trace = record(measured.trace);
		const rawSamples = Array.isArray(trace.samples) ? trace.samples : [];
		const rawPhases = Array.isArray(source.phases) ? source.phases : [];
		const payload = {
			version: 1,
			status: "collected",
			readySampleSource: "unknown-test-cannot-observe-fallback",
			targetId:
				typeof source.targetId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(source.targetId)
					? source.targetId
					: UNKNOWN,
			phases: rawPhases.slice(0, 4).map(value => {
				const phase = record(value);
				return {
					phase: typeof phase.phase === "string" && HOST_PHASES.has(phase.phase) ? phase.phase : UNKNOWN,
					wallMs: number(phase.wallMs),
					monotonicMs: number(phase.monotonicMs),
				};
			}),
			openViewport: dimensions(source.openViewport),
			observed: dimensions(run.observed),
			window: dimensions(run.window),
			beforeObserveMs: number(diagnostic.beforeObserveMs),
			afterObserveMs: number(diagnostic.afterObserveMs),
			measuredAt: number(measured.at),
			measuredWallMs: number(measured.wallMs),
			timeOrigin: number(trace.timeOrigin),
			readErrors: number(trace.readErrors),
			dropped: number(trace.dropped),
			truncated: rawSamples.length > VIEWPORT_RECORD_LIMIT || rawPhases.length > 4,
			omittedSamples: Math.max(0, rawSamples.length - VIEWPORT_RECORD_LIMIT),
			samples: rawSamples.slice(0, VIEWPORT_RECORD_LIMIT).map(sample),
		};
		for (;;) {
			const line = PREFIX + stringify(payload);
			// Copied strings are an ASCII allowlist, so length is also the UTF-8 byte count.
			if (line.length <= VIEWPORT_OUTPUT_LIMIT) return line;
			if (!payload.samples.length) return PREFIX + '{"status":"truncated","readySampleSource":"unknown"}';
			payload.samples.pop();
			payload.truncated = true;
			payload.omittedSamples += 1;
		}
	} catch {
		return PREFIX + '{"status":"diagnostic-read-or-serialization-failed","readySampleSource":"unknown"}';
	}
}

/** Diagnostics can never replace the assertion/navigation failure or prevent finally cleanup. */
export function reportViewportDiagnostic(input: unknown, write: (line: string) => void = console.error): void {
	try {
		write(viewportDiagnosticLine(input));
	} catch {
		/* Preserve the caller's original failure. */
	}
}
