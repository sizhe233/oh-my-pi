import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "../native";

describe("embedded shell env policy across the native boundary", () => {
	it("keeps env external even when shell code enables builtins", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-policy-"));
		const shell = new Shell();
		try {
			let output = "";
			const result = await shell.run(
				{ command: "enable env; PATH= env -i OMP_ENV_ONLY=1", cwd, timeoutMs: 5000 },
				(error, chunk) => {
					if (error) throw error;
					output += chunk;
				},
			);
			expect(result.exitCode).toBe(127);
			expect(output).toContain("env: command not found");
			expect(output).not.toContain("OMP_ENV_ONLY=1");
			expect(result.cancelled).toBe(false);
			expect(result.timedOut).toBe(false);
		} finally {
			try {
				await shell.abort();
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		}
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"preserves system env clear, unset and fresh executable lookup",
		async () => {
			expect(await Bun.file("/usr/bin/env").exists()).toBe(true);
			expect(await Bun.file("/bin/bash").exists()).toBe(true);
			const cases: Array<{ command: string; output: string; code: number }> = [
				{ command: "PATH=/usr/bin:/bin; f() { :; }; export -f f; env -i /usr/bin/env", output: "", code: 0 },
				{
					command:
						"PATH=/usr/bin:/bin; f() { :; }; export -f f; env -u BASH_FUNC_f%% /bin/bash --noprofile --norc -c 'if declare -F f >/dev/null; then echo leaked; else echo absent; fi'",
					output: "absent\n",
					code: 0,
				},
				{
					command: "PATH=/usr/bin:/bin; hash -p /bin/false omp-env-probe-missing; env omp-env-probe-missing",
					output: "",
					code: 127,
				},
				{
					command:
						"PATH=/omp-env-absent; export -n PATH; hash -p /usr/bin/env env; env -i sh -c 'printf default-found'",
					output: "default-found",
					code: 0,
				},
			];
			for (const fixture of cases) {
				const shell = new Shell();
				let output = "";
				try {
					const result = await shell.run({ command: fixture.command, timeoutMs: 5000 }, (error, chunk) => {
						if (error) throw error;
						output += chunk;
					});
					expect(result.exitCode).toBe(fixture.code);
					expect(result.cancelled).toBe(false);
					expect(result.timedOut).toBe(false);
					if (fixture.code === 0) expect(output).toBe(fixture.output);
				} finally {
					await shell.abort();
				}
			}
		},
		30_000,
	);
});
