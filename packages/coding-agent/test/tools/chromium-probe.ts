import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type ChildProcess, ptree, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import type { ExecResult } from "@oh-my-pi/pi-utils/ptree";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

import {
	CHROMIUM_DIAGNOSTIC_LIMITS,
	collectChromiumFailureSnapshot,
	type ChromiumFailureContext,
	type ChromiumFailureSnapshot,
} from "./chromium-probe-diagnostics";

const DIAGNOSTIC_TEXT_LIMIT = 4096;
type ProbeStage =
	| "resolve"
	| "stat"
	| "profile"
	| "port"
	| "spawn"
	| "cdp"
	| "exit-code"
	| "snapshot"
	| "stdout"
	| "kill"
	| "wait"
	| "stderr"
	| "remove";

interface ProbeError {
	stage: ProbeStage;
	name: string;
	message: string;
}

export interface ChromiumProbeDiagnostic {
	platform: NodeJS.Platform;
	executable?: string;
	cdpUrl?: string;
	timeoutMs?: number;
	elapsedMs: number;
	error: ProbeError;
	cleanupErrors: ProbeError[];
	exitCodeBeforeCleanup?: number | null;
	stderr?: string;
	stdoutCodeUnits?: number;
	runtime?: {
		failureAtMs: number;
		startedAtMs: number;
		finishedAtMs: number;
		budgetMs: number;
		outcome: "complete" | "partial" | "timed-out" | "error";
		snapshot?: ChromiumFailureSnapshot;
	};
}

interface ProbeResult {
	available: boolean;
	diagnostic?: ChromiumProbeDiagnostic;
}

/** Narrow seams keep these tests from mutating Bun, process.env, or module mocks. */
export interface ChromiumProbeHost {
	platform: () => NodeJS.Platform;
	ci: () => string | undefined;
	githubActions: () => string | undefined;
	hasDisplay: () => boolean;
	now: () => number;
	resolveExecutable: () => Promise<string | undefined>;
	isFile: (executable: string) => Promise<boolean>;
	makeProfile: () => Promise<string>;
	findPort: () => Promise<number>;
	spawn: (args: string[]) => Pick<ChildProcess, "pid" | "exitCode" | "peekStderr" | "kill" | "wait">;
	waitForCdp: (url: string, timeoutMs: number) => Promise<void>;
	captureFailure?: (context: ChromiumFailureContext, signal: AbortSignal) => Promise<ChromiumFailureSnapshot>;
	removeProfile: (directory: string) => Promise<void>;
	report: (diagnostic: ChromiumProbeDiagnostic) => void;
}

function diagnosticText(value: string): string {
	return truncate(sanitizeText(value), DIAGNOSTIC_TEXT_LIMIT);
}

function probeError(stage: ProbeStage, error: unknown): ProbeError {
	return {
		stage,
		name: diagnosticText(error instanceof Error ? error.name : "Error"),
		message: diagnosticText(error instanceof Error ? error.message : String(error)),
	};
}

/** Test-only availability gate; production browser discovery and launch stay untouched. */
export function createChromiumProbe(host: ChromiumProbeHost) {
	async function probeCdp(executable: string, timeoutMs = 5000, captureRuntime = false): Promise<ProbeResult> {
		const started = host.now();
		let stage: ProbeStage = "profile";
		let directory: string | undefined;
		let child: Pick<ChildProcess, "pid" | "exitCode" | "peekStderr" | "kill" | "wait"> | undefined;
		let error: ProbeError | undefined;
		const cleanupErrors: ProbeError[] = [];
		let cdpUrl: string | undefined;
		let exitCodeBeforeCleanup: number | null | undefined;
		let stderr: string | undefined;
		let stdoutCodeUnits: number | undefined;
		let runtime: ChromiumProbeDiagnostic["runtime"];
		let port: number | undefined;
		let failureAtMs: number | undefined;
		try {
			directory = await host.makeProfile();
			stage = "port";
			port = await host.findPort();
			cdpUrl = `http://127.0.0.1:${port}`;
			stage = "spawn";
			child = host.spawn([
				executable,
				"--headless=new",
				"--no-sandbox",
				"--no-first-run",
				"--no-default-browser-check",
				`--user-data-dir=${directory}`,
				`--remote-debugging-port=${port}`,
				"about:blank",
			]);
			stage = "cdp";
			await host.waitForCdp(cdpUrl, timeoutMs);
		} catch (cause) {
			error = probeError(stage, cause);
			try {
				failureAtMs = host.now();
			} catch (clockError) {
				cleanupErrors.push(probeError("snapshot", clockError));
			}
		} finally {
			if (child) {
				// A probe intentionally kills its browser. Do not report that signal as the startup exit.
				try {
					exitCodeBeforeCleanup = child.exitCode;
				} catch (cause) {
					cleanupErrors.push(probeError("exit-code", cause));
				}
				// Readiness has already failed. This observation cannot extend or retry that decision.
				if (captureRuntime && error && port !== undefined) {
					const controller = new AbortController();
					let timer: NodeJS.Timeout | undefined;
					try {
						const capture = host.captureFailure;
						if (capture && host.platform() === "linux") {
							failureAtMs ??= host.now();
							runtime = {
								failureAtMs,
								startedAtMs: host.now(),
								finishedAtMs: 0,
								budgetMs: CHROMIUM_DIAGNOSTIC_LIMITS.timeMs,
								outcome: "error",
							};
							const context = { rootPid: child.pid, executable, port, failureAtMs };
							const expired = Promise.withResolvers<never>();
							timer = setTimeout(() => {
								controller.abort();
								expired.reject(new Error("Diagnostic collection exceeded its 200ms budget"));
							}, CHROMIUM_DIAGNOSTIC_LIMITS.timeMs);
							const pending = Promise.resolve().then(() => capture(context, controller.signal));
							const snapshot = await Promise.race([pending, expired.promise]);
							runtime.snapshot = snapshot;
							runtime.outcome = snapshot.partial ? "partial" : "complete";
						}
					} catch (cause) {
						if (runtime) runtime.outcome = controller.signal.aborted ? "timed-out" : "error";
						cleanupErrors.push(probeError("snapshot", cause));
					} finally {
						clearTimeout(timer);
						controller.abort();
						try {
							if (runtime) runtime.finishedAtMs = host.now();
						} catch (cause) {
							cleanupErrors.push(probeError("snapshot", cause));
						}
					}
				}
				try {
					child.kill(undefined, -1);
				} catch (cause) {
					cleanupErrors.push(probeError("kill", cause));
				}
				let result: ExecResult | undefined;
				try {
					result = await child.wait({ allowAbort: true, allowNonZero: true });
				} catch (cause) {
					cleanupErrors.push(probeError("wait", cause));
				}
				if (error && result) {
					try {
						// UTF-16 code units from the existing post-kill drain; no content or pre-kill reads.
						stdoutCodeUnits = result.stdout.length;
					} catch (cause) {
						cleanupErrors.push(probeError("stdout", cause));
					}
				}
				// ptree drains stderr internally; retain only a bounded, sanitized diagnostic.
				try {
					stderr = diagnosticText(child.peekStderr());
				} catch (cause) {
					cleanupErrors.push(probeError("stderr", cause));
				}
			}
			if (directory !== undefined) {
				try {
					await host.removeProfile(directory);
				} catch (cause) {
					cleanupErrors.push(probeError("remove", cause));
				}
			}
		}
		const primaryError = error ?? cleanupErrors.shift();
		if (!primaryError) return { available: true };
		return {
			available: false,
			diagnostic: {
				platform: host.platform(),
				executable: diagnosticText(executable),
				cdpUrl,
				timeoutMs,
				elapsedMs: host.now() - started,
				error: primaryError,
				cleanupErrors,
				exitCodeBeforeCleanup,
				stderr,
				stdoutCodeUnits,
				runtime,
			},
		};
	}

	async function canLaunch(): Promise<ProbeResult> {
		const started = host.now();
		let stage: ProbeStage = "resolve";
		let executable: string | undefined;
		try {
			executable = await host.resolveExecutable();
			if (!executable) throw new Error("No Chromium executable resolved");
			if (host.platform() === "linux") return await probeCdp(executable, 5000, true);
			// GUI --version probes can hang or activate the user's browser on macOS/Windows.
			stage = "stat";
			if (!(await host.isFile(executable))) throw new Error("Chromium executable is not a file");
			return { available: true };
		} catch (cause) {
			return {
				available: false,
				diagnostic: {
					platform: host.platform(),
					executable: executable === undefined ? undefined : diagnosticText(executable),
					elapsedMs: host.now() - started,
					error: probeError(stage, cause),
					cleanupErrors: [],
				},
			};
		}
	}

	let probe: Promise<boolean> | undefined;
	function chromiumAvailable(): Promise<boolean> {
		probe ??= canLaunch().then(result => {
			if (result.available) return true;
			const diagnostic = result.diagnostic!;
			const required = [host.ci(), host.githubActions()].some(value => value === "true" || value === "1");
			// Reporting must not hide the original probe failure or change local skip behavior.
			try {
				host.report(diagnostic);
			} catch {}
			if (required) throw new Error(`Chromium unavailable in CI: ${JSON.stringify(diagnostic)}`);
			return false;
		});
		return probe;
	}

	let visibleProbe: Promise<boolean> | undefined;
	function visibleBrowserAvailable(): Promise<boolean> {
		visibleProbe ??= (async () => {
			if (!(await chromiumAvailable())) return false;
			return host.platform() !== "linux" || host.hasDisplay();
		})();
		return visibleProbe;
	}

	return {
		chromiumAvailable,
		visibleBrowserAvailable,
		// Negative wrapper tests deliberately call this low-level boolean API, including in CI.
		chromiumCdpAvailable: async (executable: string, timeoutMs = 5000): Promise<boolean> =>
			(await probeCdp(executable, timeoutMs)).available,
	};
}

const probe = createChromiumProbe({
	platform: () => process.platform,
	ci: () => process.env.CI,
	githubActions: () => process.env.GITHUB_ACTIONS,
	hasDisplay: () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
	now: Date.now,
	resolveExecutable: () => ensureChromiumExecutable(),
	isFile: async executable => (await fs.stat(executable)).isFile(),
	makeProfile: () => fs.mkdtemp(path.join(os.tmpdir(), "omp-chromium-probe-")),
	findPort: () => findFreeCdpPort(),
	spawn: args => ptree.spawn(args, { stdin: "ignore", detached: true, subreaper: true }),
	waitForCdp: (url, timeoutMs) => waitForCdp(url, timeoutMs),
	captureFailure: collectChromiumFailureSnapshot,
	removeProfile: directory => fs.rm(directory, { recursive: true, force: true }),
	// Only used by tests. JSON keeps stderr newlines/commands inside a single bounded record.
	report: diagnostic => console.error(`[chromium-probe] ${JSON.stringify(diagnostic)}`),
});

/** Single-flight real-browser gate: CI failures fail tests; local unavailable hosts may skip. */
export function chromiumAvailable(): Promise<boolean> {
	return probe.chromiumAvailable();
}
/** A disposable headless launch must answer CDP, not just --version. */
export function chromiumCdpAvailable(executable: string, timeoutMs = 5000): Promise<boolean> {
	return probe.chromiumCdpAvailable(executable, timeoutMs);
}
/** Linux headful tests still require a display after the headless check succeeds. */
export function visibleBrowserAvailable(): Promise<boolean> {
	return probe.visibleBrowserAvailable();
}
