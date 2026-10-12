import * as assert from "node:assert/strict";
import * as net from "node:net";
import { describe, it } from "bun:test";
import { probeCdpStatus } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { ChildProcess } from "@oh-my-pi/pi-utils";
import { createChromiumProbe, type ChromiumProbeDiagnostic, type ChromiumProbeHost } from "./chromium-probe";

import {
	CHROMIUM_DIAGNOSTIC_LIMITS,
	collectChromiumFailureSnapshot,
	createChromiumProcReader,
	type ChromiumFailureSnapshot,
	type ChromiumProcReader,
} from "./chromium-probe-diagnostics";

function harness(overrides: Partial<ChromiumProbeHost> = {}) {
	const events: string[] = [];
	const diagnostics: ChromiumProbeDiagnostic[] = [];
	let exitCode: number | null = null;
	const child: Pick<ChildProcess, "pid" | "exitCode" | "peekStderr" | "kill" | "wait"> = {
		pid: 123,
		get exitCode() {
			return exitCode;
		},
		peekStderr: () => "",
		kill: () => {
			events.push("kill");
			exitCode = 137;
		},
		wait: async () => {
			events.push("wait");
			return { stdout: "", stderr: "", exitCode, ok: false };
		},
	};
	const host: ChromiumProbeHost = {
		platform: () => "linux",
		ci: () => "false",
		githubActions: () => undefined,
		hasDisplay: () => false,
		now: () => 1000,
		resolveExecutable: async () => {
			events.push("resolve");
			return "/browser/chrome";
		},
		isFile: async () => {
			events.push("stat");
			return true;
		},
		makeProfile: async () => {
			events.push("profile");
			return "/temporary/profile";
		},
		findPort: async () => 9222,
		spawn: () => {
			events.push("spawn");
			return child;
		},
		waitForCdp: async () => {
			events.push("cdp");
		},
		removeProfile: async () => {
			events.push("remove");
		},
		report: diagnostic => diagnostics.push(diagnostic),
		...overrides,
	};
	return { host, child, events, diagnostics, probe: createChromiumProbe(host) };
}

describe("Chromium test availability diagnostics", () => {
	it("fails CI instead of silently skipping every importing suite, with a single cached diagnostic", async () => {
		const state = harness({
			ci: () => "true",
			waitForCdp: async () => {
				throw new Error("CDP endpoint refused");
			},
		});
		const first = state.probe.chromiumAvailable();
		const second = state.probe.chromiumAvailable();
		await assert.rejects(first, /Chromium unavailable in CI.*CDP endpoint refused/);
		await assert.rejects(second, /Chromium unavailable in CI.*CDP endpoint refused/);
		await assert.rejects(state.probe.visibleBrowserAvailable(), /CDP endpoint refused/);
		assert.equal(state.events.filter(event => event === "spawn").length, 1);
		assert.equal(state.diagnostics.length, 1);
		assert.equal(state.diagnostics[0]!.error.stage, "cdp");
	});

	it("keeps an unavailable local browser skippable when CI is explicitly false", async () => {
		const state = harness({ resolveExecutable: async () => undefined });
		assert.equal(await state.probe.chromiumAvailable(), false);
		assert.equal(await state.probe.visibleBrowserAvailable(), false);
		assert.equal(state.diagnostics.length, 1);
		assert.equal(state.diagnostics[0]!.error.stage, "resolve");
		assert.equal(state.events.includes("spawn"), false);
	});

	it("does not let CI=false disable fail-closed behavior inside GitHub Actions", async () => {
		const state = harness({ githubActions: () => "true", resolveExecutable: async () => undefined });
		await assert.rejects(state.probe.chromiumAvailable(), /No Chromium executable resolved/);
	});

	it("recognizes CI=1 and retains executable-resolution errors before a child exists", async () => {
		const state = harness({
			ci: () => "1",
			resolveExecutable: async () => {
				throw new Error("browser installation failed");
			},
		});
		await assert.rejects(state.probe.chromiumAvailable(), /browser installation failed/);
		assert.equal(state.diagnostics[0]!.error.stage, "resolve");
		assert.equal(state.events.length, 0);
	});

	it("keeps the low-level negative CDP probe false even in CI", async () => {
		const state = harness({
			ci: () => "true",
			waitForCdp: async () => {
				throw new Error("wrapper never opens CDP");
			},
		});
		assert.equal(await state.probe.chromiumCdpAvailable("/wrapper/chrome"), false);
		assert.deepEqual(state.events, ["profile", "spawn", "kill", "wait", "remove"]);
		assert.equal(state.diagnostics.length, 0);
	});

	it("records the selected executable, original deadline and pre-kill exit separately from cleanup", async () => {
		const state = harness();
		let args: string[] = [];
		state.host.spawn = command => {
			args = command;
			return state.child;
		};
		state.host.waitForCdp = async (url, timeoutMs) => {
			assert.equal(url, "http://127.0.0.1:9222");
			assert.equal(timeoutMs, 5000);
			throw new Error("deadline reached");
		};
		assert.equal(await state.probe.chromiumAvailable(), false);
		assert.deepEqual(args, [
			"/browser/chrome",
			"--headless=new",
			"--no-sandbox",
			"--no-first-run",
			"--no-default-browser-check",
			"--user-data-dir=/temporary/profile",
			"--remote-debugging-port=9222",
			"about:blank",
		]);
		assert.equal(state.diagnostics[0]!.executable, "/browser/chrome");
		assert.equal(state.diagnostics[0]!.exitCodeBeforeCleanup, null);
		assert.equal(state.child.exitCode, 137);
	});

	it("retains the startup error when kill, wait and profile removal also fail", async () => {
		const state = harness({
			ci: () => "true",
			waitForCdp: async () => {
				throw new Error("initial CDP failure");
			},
			removeProfile: async () => {
				throw new Error("profile still locked");
			},
		});
		state.child.kill = () => {
			throw new Error("kill denied");
		};
		state.child.wait = async () => {
			throw new Error("wait failed");
		};
		await assert.rejects(
			state.probe.chromiumAvailable(),
			/initial CDP failure.*kill denied.*wait failed.*profile still locked/,
		);
		assert.equal(state.diagnostics[0]!.error.stage, "cdp");
		assert.deepEqual(
			state.diagnostics[0]!.cleanupErrors.map(error => error.stage),
			["kill", "wait", "remove"],
		);
	});

	it("does not hide a cleanup-only failure after CDP answered", async () => {
		const state = harness({
			ci: () => "true",
			removeProfile: async () => {
				throw new Error("cannot remove probe profile");
			},
		});
		await assert.rejects(state.probe.chromiumAvailable(), /cannot remove probe profile/);
		assert.equal(state.diagnostics[0]!.error.stage, "remove");
	});

	it("does not lose the startup error or profile cleanup when reading child diagnostics throws", async () => {
		const state = harness({
			ci: () => "true",
			waitForCdp: async () => {
				throw new Error("original CDP failure");
			},
		});
		Object.defineProperty(state.child, "exitCode", {
			get: () => {
				throw new Error("exit status unavailable");
			},
		});
		state.child.peekStderr = () => {
			throw new Error("stderr unavailable");
		};
		await assert.rejects(
			state.probe.chromiumAvailable(),
			/original CDP failure.*exit status unavailable.*stderr unavailable/,
		);
		assert.equal(state.diagnostics[0]!.error.stage, "cdp");
		assert.deepEqual(
			state.diagnostics[0]!.cleanupErrors.map(error => error.stage),
			["exit-code", "stderr"],
		);
		assert.deepEqual(state.events.slice(-3), ["kill", "wait", "remove"]);
	});

	it("sanitizes and bounds child stderr rather than printing raw terminal or workflow commands", async () => {
		const state = harness({
			waitForCdp: async () => {
				throw new Error("startup failed");
			},
		});
		state.child.peekStderr = () => `\u001b[31mloader error\u001b[0m\u0000\n::error::untrusted\n${"x".repeat(9000)}`;
		assert.equal(await state.probe.chromiumAvailable(), false);
		const diagnostic = state.diagnostics[0]!;
		assert.match(diagnostic.stderr!, /loader error/);
		assert.ok(diagnostic.stderr!.length <= 4096);
		assert.doesNotMatch(diagnostic.stderr!, /[\u001b\u0000]/);
		assert.doesNotMatch(JSON.stringify(diagnostic), /[\r\n]/);
		assert.equal("env" in diagnostic, false);
	});

	it("cleans an allocated profile if port allocation or process spawn fails", async () => {
		for (const failure of ["port", "spawn"] as const) {
			const state = harness();
			if (failure === "port") {
				state.host.findPort = async () => {
					throw new Error("no free port");
				};
			} else {
				state.host.spawn = () => {
					throw new Error("cannot spawn");
				};
			}
			assert.equal(await state.probe.chromiumAvailable(), false);
			assert.equal(state.diagnostics[0]!.error.stage, failure);
			assert.deepEqual(state.events, ["resolve", "profile", "remove"]);
		}
	});

	it("reports temporary-profile creation failures without trying to remove an unknown path", async () => {
		const state = harness({
			makeProfile: async () => {
				throw new Error("no temporary space");
			},
		});
		assert.equal(await state.probe.chromiumAvailable(), false);
		assert.equal(state.diagnostics[0]!.error.stage, "profile");
		assert.deepEqual(state.events, ["resolve"]);
	});

	it("finishes cleanup once for concurrent successful consumers and preserves the display gate", async () => {
		const state = harness({ ci: () => "true" });
		assert.deepEqual(await Promise.all([state.probe.chromiumAvailable(), state.probe.chromiumAvailable()]), [
			true,
			true,
		]);
		assert.equal(await state.probe.visibleBrowserAvailable(), false);
		assert.deepEqual(state.events, ["resolve", "profile", "spawn", "cdp", "kill", "wait", "remove"]);
		assert.equal(state.diagnostics.length, 0);
		const visible = harness({ ci: () => "true", hasDisplay: () => true });
		assert.equal(await visible.probe.visibleBrowserAvailable(), true);
	});

	it("does not execute GUI browsers on macOS or Windows merely to check availability", async () => {
		for (const platform of ["darwin", "win32"] as const) {
			const state = harness({ platform: () => platform, ci: () => "true" });
			assert.equal(await state.probe.visibleBrowserAvailable(), true);
			assert.deepEqual(state.events, ["resolve", "stat"]);
		}
		const stale = harness({ platform: () => "win32", ci: () => "true", isFile: async () => false });
		await assert.rejects(stale.probe.chromiumAvailable(), /Chromium executable is not a file/);
		assert.equal(stale.diagnostics[0]!.error.stage, "stat");
	});

	it("keeps the probe failure visible when the diagnostic sink itself throws", async () => {
		const state = harness({
			ci: () => "true",
			resolveExecutable: async () => undefined,
			report: () => {
				throw new Error("stderr unavailable");
			},
		});
		await assert.rejects(state.probe.chromiumAvailable(), /No Chromium executable resolved/);
	});
});

const tcpHeader = "  sl  local_address rem_address st tx_queue rx_queue\n";

const failureContext = { rootPid: 100, executable: "/usr/bin/google-chrome", port: 9222, failureAtMs: 1000 };

function statFixture(pid: number, ppid: number, start = "100") {
	return `${pid} (name with spaces) S ${ppid} ${Array(17).fill("0").join(" ")} ${start}\n`;
}

function procReader(overrides: Partial<ChromiumProcReader> = {}): ChromiumProcReader {
	return {
		read: async file => {
			const text = file === "/proc/100/stat" ? statFixture(100, 1) : file.startsWith("/proc/net/") ? tcpHeader : "";
			return { text, bytes: Buffer.byteLength(text), truncated: false };
		},
		names: async () => ({ names: [], truncated: false }),
		readlink: async () => "/usr/bin/bun",
		realpath: async () => "/opt/google/chrome/google-chrome",
		...overrides,
	};
}

function failingHarness() {
	return harness({
		ci: () => "true",
		waitForCdp: async () => {
			throw new Error("original CDP timeout");
		},
	});
}

describe("Chromium failure-only runtime observation", () => {
	it("does not collect runtime snapshots for deliberate low-level negative probes", async () => {
		const state = failingHarness();
		let captures = 0;
		state.host.captureFailure = async (context, signal) => {
			captures++;
			return collectChromiumFailureSnapshot(context, signal, procReader());
		};
		assert.equal(await state.probe.chromiumCdpAvailable("/wrapper/chrome"), false);
		assert.equal(captures, 0);
		assert.deepEqual(state.events.slice(-3), ["kill", "wait", "remove"]);
	});

	it("captures only after failure and before owned cleanup, without turning a listener into success", async () => {
		const state = failingHarness();
		state.host.captureFailure = async (context, signal) => {
			state.events.push("snapshot");
			return collectChromiumFailureSnapshot(
				context,
				signal,
				procReader({
					read: async () => ({ text: "0: 0100007F:2406 00000000:0000 0A\n", bytes: 40, truncated: false }),
				}),
			);
		};
		state.child.wait = async () => {
			state.events.push("wait");
			return { stdout: "secret stdout", stderr: "", exitCode: 137, ok: false };
		};
		await assert.rejects(state.probe.chromiumAvailable(), /original CDP timeout/);
		const diagnostic = state.diagnostics[0]!;
		assert.equal(diagnostic.runtime!.snapshot!.listener.loopbackIpv4, true);
		assert.equal(diagnostic.stdoutCodeUnits, 13);
		assert.doesNotMatch(JSON.stringify(diagnostic), /secret stdout/);
		assert.deepEqual(state.events.slice(-4), ["snapshot", "kill", "wait", "remove"]);
		const success = harness();
		success.host.captureFailure = async () => {
			throw new Error("must not observe a successful launch");
		};
		assert.equal(await success.probe.chromiumAvailable(), true);
	});

	it("bounds a stalled collector and ignores late observations while retaining the original failure", async () => {
		const state = failingHarness();
		const late = Promise.withResolvers<ChromiumFailureSnapshot>();
		let signal: AbortSignal | undefined;
		state.host.captureFailure = (_context, capturedSignal) => {
			signal = capturedSignal;
			return late.promise;
		};
		const started = Date.now();
		await assert.rejects(state.probe.chromiumAvailable(), /original CDP timeout/);
		assert.ok(Date.now() - started < 1500);
		assert.equal(signal!.aborted, true);
		assert.equal(state.diagnostics[0]!.runtime!.outcome, "timed-out");
		assert.deepEqual(state.events.slice(-3), ["kill", "wait", "remove"]);
		const captured = JSON.stringify(state.diagnostics);
		late.resolve(await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, procReader()));
		await Promise.resolve();
		assert.equal(JSON.stringify(state.diagnostics), captured);
	});

	it("preserves cleanup when capture, PID, or post-kill stdout getters throw", async () => {
		for (const kind of ["capture", "pid", "stdout"] as const) {
			const state = failingHarness();
			state.host.captureFailure = (context, signal) => collectChromiumFailureSnapshot(context, signal, procReader());
			if (kind === "capture") {
				Object.defineProperty(state.host, "captureFailure", {
					get() {
						throw new Error("capture getter failed");
					},
				});
			} else if (kind === "pid") {
				Object.defineProperty(state.child, "pid", {
					get() {
						throw new Error("pid getter failed");
					},
				});
			} else {
				state.child.wait = async () => {
					state.events.push("wait");
					return {
						get stdout(): string {
							throw new Error("stdout getter failed");
						},
						stderr: "",
						exitCode: 137,
						ok: false,
					};
				};
			}
			await assert.rejects(state.probe.chromiumAvailable(), /original CDP timeout/);
			assert.equal(state.diagnostics[0]!.error.stage, "cdp");
			assert.ok(state.diagnostics[0]!.cleanupErrors.some(error => /getter failed/.test(error.message)));
			assert.deepEqual(state.events.slice(-3), ["kill", "wait", "remove"]);
		}
	});

	it("filters descendants by sampled identity and filters listeners by port without raw process content", async () => {
		const reader = procReader({
			read: async file => {
				let text = "";
				if (file === "/proc/net/tcp") {
					text = `${tcpHeader}0: 0100007F:2406 00000000:0000 0A\n1: 00000000:9999 00000000:0000 0A\n`;
				} else if (file === "/proc/100/stat") text = statFixture(100, 1);
				else if (file === "/proc/101/stat") text = statFixture(101, 100);
				else if (file === "/proc/102/stat") text = statFixture(102, 999);
				else if (file === "/proc/100/task/105/children") text = "101 102";
				return { text, bytes: Buffer.byteLength(text), truncated: false };
			},
			names: async directory => ({ names: directory === "/proc/100/task" ? ["105"] : [], truncated: false }),
			readlink: async file => (file === "/proc/101/exe" ? "/opt/google/chrome/chrome" : "/usr/bin/bun"),
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.deepEqual(
			result.processes.map(process => [process.pid, process.ppid, process.executableBasename]),
			[
				[100, 1, "bun"],
				[101, 100, "chrome"],
			],
		);
		assert.equal(result.listener.loopbackIpv4, true);
		assert.equal(result.listener.wildcardIpv4, false);
		assert.equal(result.selectedRealBasename, "google-chrome");
		assert.ok(result.issues.includes("identity"));
		assert.doesNotMatch(JSON.stringify(result), /name with spaces|9999|\/opt\/|cmdline|environ/);
	});

	it("discards a PID whose start time changes during executable inspection", async () => {
		let reads = 0;
		const reader = procReader({
			read: async file => {
				const text = file.endsWith("/stat") ? statFixture(100, 1, String(++reads)) : "";
				return { text, bytes: Buffer.byteLength(text), truncated: false };
			},
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.deepEqual(result.processes, []);
		assert.ok(result.issues.includes("identity"));
	});

	it("reports an unreadable or truncated listener table as unknown rather than absent", async () => {
		const reader = procReader({
			read: async file => {
				if (file.endsWith("tcp6")) throw new Error("unreadable");
				return { text: "", bytes: 0, truncated: true };
			},
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.deepEqual(result.listener, { port: 9222, loopbackIpv4: null, wildcardIpv4: null, ipv6Port: null });
		assert.equal(result.partial, true);
		assert.ok(result.issues.includes("read"));
		assert.ok(result.issues.includes("limit"));
	});

	it("caps aggregate collection bytes while exposing incompleteness", async () => {
		let requestedBytes = 0;
		const reader = procReader({
			read: async (file, maximum) => {
				requestedBytes += maximum;
				let text = "";
				const match = /^\/proc\/(\d+)\/stat$/.exec(file);
				if (match) text = statFixture(Number(match[1]), match[1] === "100" ? 1 : 100);
				else if (file.endsWith("/children")) {
					text = Array.from({ length: 100 }, (_, index) => index + 101).join(" ");
				}
				return { text, bytes: maximum, truncated: true };
			},
			names: async (_directory, maximum) => ({
				names: Array.from({ length: maximum }, (_, i) => String(i + 100)),
				truncated: true,
			}),
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.ok(result.bytesRead <= CHROMIUM_DIAGNOSTIC_LIMITS.bytes);
		assert.ok(requestedBytes <= CHROMIUM_DIAGNOSTIC_LIMITS.bytes);
		assert.ok(result.processes.length <= CHROMIUM_DIAGNOSTIC_LIMITS.processes);
		assert.ok(result.tasksRead <= CHROMIUM_DIAGNOSTIC_LIMITS.tasks);
		assert.ok(result.pathLookups <= CHROMIUM_DIAGNOSTIC_LIMITS.pathLookups);
		assert.ok(result.issues.includes("limit"));
	});

	it("bounds a wide descendant tree and the number of executable lookups", async () => {
		const reader = procReader({
			read: async file => {
				let text = tcpHeader;
				const match = /^\/proc\/(\d+)\/stat$/.exec(file);
				if (match) text = statFixture(Number(match[1]), match[1] === "100" ? 1 : 100);
				else if (file.endsWith("/children")) {
					text = Array.from({ length: 100 }, (_, index) => index + 101).join(" ");
				}
				return { text, bytes: Buffer.byteLength(text), truncated: false };
			},
			names: async directory => ({ names: directory === "/proc/100/task" ? ["100"] : [], truncated: false }),
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.equal(result.processes.length, CHROMIUM_DIAGNOSTIC_LIMITS.processes);
		assert.equal(result.pathLookups, CHROMIUM_DIAGNOSTIC_LIMITS.pathLookups);
		assert.ok(result.issues.includes("limit"));
	});

	it("caps task enumeration without treating an incomplete child scan as absence", async () => {
		const reader = procReader({
			names: async (_directory, maximum) => ({
				names: Array.from({ length: maximum }, (_, index) => String(index + 100)),
				truncated: true,
			}),
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.ok(result.tasksRead <= CHROMIUM_DIAGNOSTIC_LIMITS.tasks - CHROMIUM_DIAGNOSTIC_LIMITS.processes + 1);
		assert.equal(result.processes.length, 1);
		assert.equal(result.partial, true);
		assert.ok(result.issues.includes("limit"));
	});

	it("stops awaiting an unresponsive proc read when cancelled", async () => {
		const controller = new AbortController();
		const pending = Promise.withResolvers<{ text: string; bytes: number; truncated: boolean }>();
		const result = collectChromiumFailureSnapshot(
			failureContext,
			controller.signal,
			procReader({ read: () => pending.promise }),
		);
		controller.abort();
		const snapshot = await result;
		assert.equal(snapshot.partial, true);
		assert.ok(snapshot.issues.includes("aborted"));
		assert.deepEqual(snapshot.processes, []);
	});

	it("closes a file that finishes opening after the diagnostic deadline", async () => {
		const opened = Promise.withResolvers<{
			read: () => Promise<{ bytesRead: number }>;
			close: () => Promise<void>;
		}>();
		const closed = Promise.withResolvers<void>();
		const reader = createChromiumProcReader({
			open: () => opened.promise,
			opendir: async () => {
				throw new Error("unexpected directory read");
			},
			readlink: async () => "",
			realpath: async () => "",
		});
		const controller = new AbortController();
		const result = reader.read("/proc/100/stat", 128, controller.signal);
		controller.abort();
		await assert.rejects(result, /aborted/);
		opened.resolve({ read: async () => ({ bytesRead: 0 }), close: async () => closed.resolve() });
		await closed.promise;
	});

	it("retries directory closure when an aborted pending read settles late", async () => {
		const reading = Promise.withResolvers<void>();
		const entry = Promise.withResolvers<{ name: string } | null>();
		const closed = Promise.withResolvers<void>();
		let pendingRead = true;
		let closeCalls = 0;
		const reader = createChromiumProcReader({
			open: async () => {
				throw new Error("unexpected file read");
			},
			opendir: async () => ({
				read: () => {
					reading.resolve();
					return entry.promise;
				},
				close: async () => {
					closeCalls++;
					if (pendingRead) throw new Error("directory read is still pending");
					closed.resolve();
				},
			}),
			readlink: async () => "",
			realpath: async () => "",
		});
		const controller = new AbortController();
		const result = reader.names("/proc/100/task", 32, controller.signal);
		await reading.promise;
		controller.abort();
		await assert.rejects(result, /aborted/);
		pendingRead = false;
		entry.resolve(null);
		await closed.promise;
		assert.ok(closeCalls >= 2);
	});

	it("limits filesystem reads before allocation and closes the captured file", async () => {
		let requested = 0;
		const closed = Promise.withResolvers<void>();
		const reader = createChromiumProcReader({
			open: async () => ({
				read: async (buffer, offset, length) => {
					requested += length;
					buffer.fill(120, offset, offset + length);
					return { bytesRead: length };
				},
				close: async () => closed.resolve(),
			}),
			opendir: async () => {
				throw new Error("unexpected directory read");
			},
			readlink: async () => "",
			realpath: async () => "",
		});
		const result = await reader.read("/proc/net/tcp", 128, new AbortController().signal);
		await closed.promise;
		assert.equal(requested, 128);
		assert.equal(result.bytes, 128);
		assert.equal(result.text.length, 128);
		assert.equal(result.truncated, true);
	});
});

describe("Chromium owned leader wait observations", () => {
	it("distinguishes pipe writers, readers and other kernel waits without reading process content", async () => {
		const symbols = ["do_epoll_wait", "pipe_write", "pipe_read", "futex_wait_queue", "folio_wait_bit_common"];
		const reads: string[] = [];
		const links: string[] = [];
		const names: string[] = [];
		const reader = procReader({
			read: async (file, maximum) => {
				reads.push(file);
				let text = "";
				const stat = /^\/proc\/(\d+)\/stat$/.exec(file);
				const wait = /^\/proc\/(\d+)\/task\/\1\/wchan$/.exec(file);
				if (file.startsWith("/proc/net/")) text = tcpHeader;
				else if (stat) {
					const pid = Number(stat[1]);
					text = `${pid} (PRIVATE_COMM with ) parentheses) S ${pid === 100 ? 1 : 100} 0 0 0 0 0 0 0 3 0 12 7 0 0 0 0 0 0 123456\n`;
				} else if (wait) {
					assert.ok(maximum <= 128);
					text = symbols[Number(wait[1]) - 100]!;
				} else if (file === "/proc/100/task/100/children") text = "101 102 103 104";
				return { text, bytes: Buffer.byteLength(text), truncated: false };
			},
			names: async directory => {
				names.push(directory);
				return { names: [directory.split("/")[2]!], truncated: false };
			},
			readlink: async file => {
				links.push(file);
				return "/PRIVATE_HOME/chrome";
			},
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.deepEqual(
			result.processes.map(process => process.leaderWait),
			symbols.map(symbol => ({ status: "observed", symbol })),
		);
		assert.equal(result.processes[1]!.userCpuTicks, 12);
		assert.equal(result.processes[1]!.systemCpuTicks, 7);
		assert.equal(result.processes[1]!.majorFaults, 3);
		assert.equal(result.processes[1]!.startTimeTicks, "123456");
		assert.equal(result.tasksRead, 5);
		assert.equal(result.partial, false);
		assert.ok(
			reads.every(file => /^\/proc\/(?:net\/tcp6?|10[0-4]\/(?:stat|task\/10[0-4]\/(?:children|wchan)))$/.test(file)),
		);
		assert.ok(links.every(file => /^\/proc\/10[0-4]\/exe$/.test(file)));
		assert.ok(names.every(directory => /^\/proc\/10[0-4]\/task$/.test(directory)));
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|parentheses|cmdline|environ|\/proc\/|fd/);
	});

	it("reports zero, denied, empty, truncated and malformed wait channels as distinct unknowns", async () => {
		const cases = [
			{ text: "0", reason: "zero" },
			{ text: "", code: "EACCES", reason: "denied" },
			{ text: "", code: "EPERM", reason: "denied" },
			{ text: "", code: "ENOENT", reason: "unavailable" },
			{ text: "", reason: "unavailable" },
			{ text: "pipe_write", truncated: true, reason: "truncated" },
			{ text: "pipe_write\n::error::PRIVATE_TOKEN", reason: "invalid" },
		];
		for (const example of cases) {
			const base = procReader();
			const result = await collectChromiumFailureSnapshot(
				failureContext,
				new AbortController().signal,
				procReader({
					read: async (file, maximum, signal) => {
						if (!file.endsWith("/wchan")) return base.read(file, maximum, signal);
						if (example.code) throw Object.assign(new Error("PRIVATE_ERROR"), { code: example.code });
						return {
							text: example.text,
							bytes: Buffer.byteLength(example.text),
							truncated: example.truncated ?? false,
						};
					},
				}),
			);
			assert.deepEqual(result.processes[0]!.leaderWait, { status: "unknown", reason: example.reason });
			assert.equal(result.partial, true);
			assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|::error::/);
		}
	});

	it("does not publish a wait channel or counters from a PID reused during the wait read", async () => {
		let reused = false;
		const base = procReader();
		const result = await collectChromiumFailureSnapshot(
			failureContext,
			new AbortController().signal,
			procReader({
				read: async (file, maximum, signal) => {
					if (file.endsWith("/wchan")) {
						reused = true;
						return { text: "pipe_write", bytes: 10, truncated: false };
					}
					if (file === "/proc/100/stat") {
						const text = statFixture(100, 1, reused ? "200" : "100");
						return { text, bytes: Buffer.byteLength(text), truncated: false };
					}
					return base.read(file, maximum, signal);
				},
			}),
		);
		assert.equal(reused, true);
		assert.deepEqual(result.processes, []);
		assert.ok(result.issues.includes("identity"));
		assert.doesNotMatch(JSON.stringify(result), /pipe_write|userCpuTicks/);
	});

	it("keeps malformed counters unknown and rejects a truncated identity rather than reporting zeroes", async () => {
		for (const truncated of [false, true]) {
			const base = procReader();
			const result = await collectChromiumFailureSnapshot(
				failureContext,
				new AbortController().signal,
				procReader({
					read: async (file, maximum, signal) => {
						if (file === "/proc/100/stat") {
							const text =
								"100 (PRIVATE_COMM) S 1 0 0 0 0 0 0 0 -1 0 PRIVATE_COUNTER 9007199254740992 0 0 0 0 0 0 100\n";
							return { text, bytes: Buffer.byteLength(text), truncated };
						}
						return base.read(file, maximum, signal);
					},
				}),
			);
			if (truncated) assert.deepEqual(result.processes, []);
			else {
				assert.equal(result.processes[0]!.majorFaults, null);
				assert.equal(result.processes[0]!.userCpuTicks, null);
				assert.equal(result.processes[0]!.systemCpuTicks, null);
			}
			assert.equal(result.partial, true);
			assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|9007199254740992/);
		}
	});

	it("reserves descendant leader slots when Bun has more tasks than the global sample can inspect", async () => {
		const sampled = new Set<string>();
		const waits: number[] = [];
		const reader = procReader({
			read: async file => {
				let text = "";
				const stat = /^\/proc\/(\d+)\/stat$/.exec(file);
				const task = /^\/proc\/(\d+)\/task\/(\d+)\/(children|wchan)$/.exec(file);
				if (file.startsWith("/proc/net/")) text = tcpHeader;
				else if (stat) text = statFixture(Number(stat[1]), stat[1] === "100" ? 1 : 100);
				else if (task) {
					sampled.add(`${task[1]}/${task[2]}`);
					if (task[3] === "wchan") {
						waits.push(Number(task[1]));
						text = task[1] === "100" ? "do_epoll_wait" : "pipe_write";
					} else if (file === "/proc/100/task/100/children") {
						text = Array.from({ length: 40 }, (_, index) => String(101 + index)).join(" ");
					}
				}
				return { text, bytes: Buffer.byteLength(text), truncated: false };
			},
			names: async (_directory, maximum) => ({
				names: Array.from({ length: maximum }, (_, index) => String(1000 + index)),
				truncated: true,
			}),
		});
		const result = await collectChromiumFailureSnapshot(failureContext, new AbortController().signal, reader);
		assert.equal(result.processes.length, 16);
		assert.deepEqual(
			waits,
			Array.from({ length: 16 }, (_, index) => 100 + index),
		);
		assert.equal(result.tasksRead, 32);
		assert.equal(sampled.size, 32);
		assert.equal(result.pathLookups, 16);
		assert.ok(result.bytesRead <= 64 * 1024);
		assert.equal(result.partial, true);
		assert.deepEqual(result.listener, { port: 9222, loopbackIpv4: false, wildcardIpv4: false, ipv6Port: false });
		assert.ok(result.issues.includes("limit"));
	});

	it("deduplicates leader and repeated task entries rather than spending extra task slots", async () => {
		const base = procReader();
		const children: string[] = [];
		const result = await collectChromiumFailureSnapshot(
			failureContext,
			new AbortController().signal,
			procReader({
				read: async (file, maximum, signal) => {
					if (file.endsWith("/children")) children.push(file);
					return base.read(file, maximum, signal);
				},
				names: async () => ({
					names: ["100", "100", "105", "105", "../PRIVATE_PATH", "9007199254740992"],
					truncated: false,
				}),
			}),
		);
		assert.equal(result.tasksRead, 2);
		assert.deepEqual(children, ["/proc/100/task/100/children", "/proc/100/task/105/children"]);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH|9007199254740992/);
	});

	it("still discovers leader-owned children when task directory access is denied", async () => {
		const base = procReader();
		const result = await collectChromiumFailureSnapshot(
			failureContext,
			new AbortController().signal,
			procReader({
				read: async (file, maximum, signal) => {
					let text: string | undefined;
					if (file === "/proc/100/task/100/children") text = "101";
					else if (file === "/proc/101/stat") text = statFixture(101, 100);
					else if (file.endsWith("/wchan")) text = "pipe_read";
					return text === undefined
						? base.read(file, maximum, signal)
						: { text, bytes: Buffer.byteLength(text), truncated: false };
				},
				names: async () => {
					throw Object.assign(new Error("PRIVATE_DIRECTORY"), { code: "EACCES" });
				},
			}),
		);
		assert.deepEqual(
			result.processes.map(process => process.pid),
			[100, 101],
		);
		assert.equal(result.tasksRead, 2);
		assert.equal(result.partial, true);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIRECTORY/);
	});

	it("abandons a stalled wait read at the existing deadline and closes its late handle after cleanup", async () => {
		const state = failingHarness();
		Object.defineProperty(state.child, "pid", { value: 100 });
		const base = procReader();
		const opened = Promise.withResolvers<{
			read: () => Promise<{ bytesRead: number }>;
			close: () => Promise<void>;
		}>();
		const closed = Promise.withResolvers<void>();
		const files = createChromiumProcReader({
			open: () => opened.promise,
			opendir: async () => {
				throw new Error("unexpected directory read");
			},
			readlink: async () => "",
			realpath: async () => "",
		});
		let waits = 0;
		state.host.captureFailure = (context, signal) =>
			collectChromiumFailureSnapshot(
				context,
				signal,
				procReader({
					read: (file, maximum, readSignal) => {
						if (!file.endsWith("/wchan")) return base.read(file, maximum, readSignal);
						waits++;
						return files.read(file, maximum, readSignal);
					},
				}),
			);
		const started = Date.now();
		await assert.rejects(state.probe.chromiumAvailable(), /original CDP timeout/);
		assert.ok(Date.now() - started < 1500);
		assert.equal(waits, 1);
		assert.equal(state.diagnostics[0]!.runtime!.budgetMs, 200);
		assert.equal(state.diagnostics[0]!.runtime!.outcome, "timed-out");
		assert.deepEqual(state.events.slice(-3), ["kill", "wait", "remove"]);
		const captured = JSON.stringify(state.diagnostics);
		opened.resolve({ read: async () => ({ bytesRead: 0 }), close: async () => closed.resolve() });
		await closed.promise;
		assert.equal(JSON.stringify(state.diagnostics), captured);
	});
});

async function withLoopbackFixture(response: string | null, run: (url: string) => Promise<void>) {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.once("error", () => {});
		socket.once("data", () => {
			if (response !== null) socket.end(response);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No loopback fixture port");
		await run(`http://127.0.0.1:${address.port}/json/version`);
	} finally {
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(error => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	}
}

describe("CDP transport without the Chromium availability gate", () => {
	it("observes a real loopback success through the production raw TCP probe", async () => {
		await withLoopbackFixture("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", async url => {
			assert.equal(await probeCdpStatus(url, { timeoutMs: 1000 }), 200);
		});
	});

	it("distinguishes a live non-2xx endpoint from an unavailable one", async () => {
		await withLoopbackFixture("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n", async url => {
			assert.equal(await probeCdpStatus(url, { timeoutMs: 1000 }), 503);
		});
	});

	it("returns null when a reachable server never supplies an HTTP status", async () => {
		await withLoopbackFixture(null, async url => {
			assert.equal(await probeCdpStatus(url, { timeoutMs: 50 }), null);
		});
	});

	it("returns null for a closed port and for an already aborted request", async () => {
		let closedUrl = "";
		await withLoopbackFixture(null, async url => {
			closedUrl = url;
			assert.equal(await probeCdpStatus(url, { timeoutMs: 1000, signal: AbortSignal.abort() }), null);
		});
		assert.equal(await probeCdpStatus(closedUrl, { timeoutMs: 1000 }), null);
	});
});
