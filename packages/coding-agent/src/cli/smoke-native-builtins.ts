import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";

interface ProbeResult {
	exitCode: number | undefined;
	output: string;
}

/** Keep all filesystem mutations inside a fresh fixture and preserve the first failure. */
async function withShellFixture<T>(label: string, probe: (shell: Shell, dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-native-${label}-smoke-`));
	let shell: Shell | undefined;
	let outcome: { value: T } | { error: unknown };
	try {
		shell = new Shell();
		outcome = { value: await probe(shell, dir) };
	} catch (error) {
		outcome = { error };
	}
	try {
		await shell?.abort();
	} catch (error) {
		if ("value" in outcome) outcome = { error };
	}
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch (error) {
		if ("value" in outcome) outcome = { error };
	}
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}

async function run(shell: Shell, dir: string, label: string, command: string): Promise<ProbeResult> {
	let output = "";
	let streamError: Error | undefined;
	const result = await shell.run({ command, cwd: dir, timeoutMs: 10_000 }, (error, chunk) => {
		if (error) {
			streamError ??= error;
			return;
		}
		if (output.length + chunk.length > 32_768) {
			streamError ??= new Error(`native builtin smoke (${label}): output exceeded the probe bound`);
		} else {
			output += chunk;
		}
	});
	if (streamError) throw streamError;
	if (result.cancelled || result.timedOut) {
		throw new Error(`native builtin smoke (${label}): command was cancelled or timed out`);
	}
	return { exitCode: result.exitCode, output: output.replaceAll("\r\n", "\n") };
}

function expectExit(result: ProbeResult, expected: number, label: string): void {
	if (result.exitCode !== expected) {
		// In particular, never include captured environment values in a CI failure log.
		throw new Error(`native builtin smoke (${label}): exit ${result.exitCode}, expected ${expected}`);
	}
}

/** Force the native builtin so a system chmod cannot mask a broken bundled implementation. */
export async function smokeTestNativeChmod(): Promise<boolean> {
	if (process.platform === "win32") return false;
	return withShellFixture("chmod", async (shell, dir) => {
		const expectMode = async (name: string, expected: number) => {
			const actual = (await fs.stat(path.join(dir, name))).mode & 0o7777;
			if (actual !== expected) {
				throw new Error(
					`native chmod smoke: ${name} has mode ${actual.toString(8)}, expected ${expected.toString(8)}`,
				);
			}
		};
		const chmod = async (args: string, expectedExit: number) => {
			const result = await run(shell, dir, "chmod", `builtin chmod ${args}`);
			expectExit(result, expectedExit, "chmod");
			if (expectedExit !== 0 && !result.output.includes("--no-dereference is not supported")) {
				throw new Error("native chmod smoke: missing unsupported-option diagnostic");
			}
		};
		await Bun.write(path.join(dir, "target"), "owned chmod smoke target\n");
		await fs.chmod(path.join(dir, "target"), 0o640);
		await Bun.write(path.join(dir, "ordinary"), "owned chmod smoke operand\n");
		await fs.chmod(path.join(dir, "ordinary"), 0o640);
		await fs.symlink("target", path.join(dir, "link"));
		await fs.mkdir(path.join(dir, "directory"));
		await fs.chmod(path.join(dir, "directory"), 0o755);
		await Bun.write(path.join(dir, "directory/child"), "owned chmod smoke child\n");
		await fs.chmod(path.join(dir, "directory/child"), 0o644);
		await fs.symlink("../target", path.join(dir, "directory/link"));
		await fs.symlink("directory", path.join(dir, "dirlink"));
		for (const flag of ["-h", "--no-dereference", "--dereference -h"]) {
			await chmod(`${flag} 700 ordinary link dirlink`, 1);
			await expectMode("ordinary", 0o640);
			await expectMode("target", 0o640);
			await expectMode("directory", 0o755);
			await expectMode("directory/child", 0o644);
		}
		for (const flags of ["-R -H -h", "-R -L --no-dereference", "-R -P -h"]) {
			await chmod(`${flags} 700 dirlink`, 1);
			await expectMode("directory", 0o755);
			await expectMode("directory/child", 0o644);
			await expectMode("target", 0o640);
		}
		await chmod("-h --dereference 700 link", 0);
		await expectMode("target", 0o700);
		await chmod("600 link", 0);
		await expectMode("target", 0o600);
		await chmod("-R 700 dirlink", 0);
		await expectMode("directory", 0o700);
		await expectMode("directory/child", 0o700);
		await expectMode("target", 0o600);
		return true;
	});
}

export async function smokeTestNativeDd(): Promise<void> {
	await withShellFixture("dd", async (shell, dir) => {
		const exists = async (file: string) => {
			try {
				await fs.stat(file);
				return true;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
				throw error;
			}
		};
		for (const [operand, kind, flag] of [
			["iflag=direct", "input", "direct"],
			["oflag=direct", "output", "direct"],
			["iflag=nocache", "input", "nocache"],
			["oflag=nocache", "output", "nocache"],
		]) {
			const cwd = path.join(dir, operand.replace("=", "-"));
			await fs.mkdir(cwd);
			await Bun.write(path.join(cwd, "input"), "new data");
			await Bun.write(path.join(cwd, "existing"), "keep existing data");
			for (const [boundary, args] of [
				["existing output", `if=input of=existing status=none ${operand}`],
				["new output", `if=input ${operand} of=new-output status=none`],
				["input open", `if=missing of=unopened ${operand} status=none`],
			]) {
				const label = `dd ${operand}, ${boundary}`;
				const result = await run(shell, cwd, label, `builtin dd ${args}`);
				expectExit(result, 1, label);
				if (!result.output.includes(`${kind} flag: '${flag}'`)) {
					throw new Error(`native builtin smoke (${label}): missing unsupported-flag diagnostic`);
				}
				if (
					(await Bun.file(path.join(cwd, "existing")).text()) !== "keep existing data" ||
					(await exists(path.join(cwd, "new-output"))) ||
					(await exists(path.join(cwd, "unopened")))
				) {
					throw new Error(`native builtin smoke (${label}): rejected invocation changed output files`);
				}
			}
		}
		const cwd = path.join(dir, "controls");
		await fs.mkdir(cwd);
		await Bun.write(path.join(cwd, "input"), "aBcD12ef");
		for (const [label, args, expected] of [
			["ordinary copy", "if=input of=copy bs=3 status=none", "aBcD12ef"],
			[
				"byte flags and conversion",
				"if=input of=copy bs=3 skip=2 count=4 iflag=skip_bytes,count_bytes conv=ucase status=none",
				"CD12",
			],
			["append", "if=input of=copy bs=2 count=1 oflag=append conv=notrunc status=none", "CD12aB"],
		]) {
			const result = await run(shell, cwd, `dd ${label}`, `builtin dd ${args}`);
			expectExit(result, 0, `dd ${label}`);
			if (result.output !== "" || (await Bun.file(path.join(cwd, "copy")).text()) !== expected) {
				throw new Error(`native dd smoke: supported ${label} behavior changed`);
			}
		}
	});
}

export async function smokeTestEnvBuiltinDisabled(): Promise<void> {
	await withShellFixture("env-boundary", async (shell, dir) => {
		const result = await run(shell, dir, "env builtin registration", "builtin env -i OMP_ENV_ONLY=1");
		expectExit(result, 1, "env builtin registration");
		if (!result.output.includes("not a shell builtin: env")) {
			throw new Error("native env smoke: expected the native builtin to be unregistered");
		}
	});
}

export async function smokeTestExternalEnv(): Promise<boolean> {
	// System env availability on Windows is a separate installation capability.
	if (process.platform === "win32") return false;
	return withShellFixture("env-external", async (shell, dir) => {
		for (const [label, command, exitCode, expectedOutput] of [
			["exported function isolation", "PATH=/usr/bin:/bin; f() { :; }; export -f f; env -i /usr/bin/env", 0, ""],
			[
				"fresh child lookup",
				"PATH=/usr/bin:/bin; hash -p /bin/false omp-env-probe-missing; env omp-env-probe-missing",
				127,
				undefined,
			],
			[
				"clean assigned environment",
				"PATH=/usr/bin:/bin; env -i OMP_ENV_ONLY=1 /usr/bin/env",
				0,
				"OMP_ENV_ONLY=1\n",
			],
		] as const) {
			const result = await run(shell, dir, `env ${label}`, command);
			expectExit(result, exitCode, `env ${label}`);
			if (expectedOutput !== undefined && result.output !== expectedOutput) {
				throw new Error(`native env smoke (${label}): child environment did not match the isolated environment`);
			}
		}
		return true;
	});
}

/** Exercise the rebuilt addon's safety boundaries through the compiled CLI smoke path. */
export async function smokeTestNativeBuiltins(): Promise<{
	chmodNoDereference: boolean;
	envExternalIsolation: boolean;
}> {
	const chmodNoDereference = await smokeTestNativeChmod();
	await smokeTestNativeDd();
	await smokeTestEnvBuiltinDisabled();
	const envExternalIsolation = await smokeTestExternalEnv();
	return { chmodNoDereference, envExternalIsolation };
}
