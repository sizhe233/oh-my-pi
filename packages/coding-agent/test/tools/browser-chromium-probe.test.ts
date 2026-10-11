import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ChildProcess } from "@oh-my-pi/pi-utils";
import { createChromiumProbe, type ChromiumProbeDiagnostic, type ChromiumProbeHost } from "./chromium-probe";

function harness(overrides: Partial<ChromiumProbeHost> = {}) {
	const events: string[] = [];
	const diagnostics: ChromiumProbeDiagnostic[] = [];
	let exitCode: number | null = null;
	const child: Pick<ChildProcess, "exitCode" | "peekStderr" | "kill" | "wait"> = {
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
		assert.deepEqual(state.diagnostics[0]!.cleanupErrors.map(error => error.stage), ["kill", "wait", "remove"]);
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
		assert.deepEqual(state.diagnostics[0]!.cleanupErrors.map(error => error.stage), ["exit-code", "stderr"]);
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
