import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AbortError, createLinuxSubreaperScript, spawn } from "@oh-my-pi/pi-utils/ptree";

describe.skipIf(process.platform !== "linux")("subreaper startup authorization", () => {
	for (const mode of ["no-channel", "disconnect", "invalid"] as const) {
		it(`does not execute when control is ${mode}`, async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-start-gate-"));
			const marker = path.join(dir, "ran");
			const child = Bun.spawn([process.execPath, "-e", createLinuxSubreaperScript()], {
				env: {
					...Bun.env,
					BUN_BE_BUN: "1",
					OMP_PTREE_SUBREAPER_COMMAND: JSON.stringify(["/bin/sh", "-c", `echo ran > '${marker}'`]),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				...(mode === "no-channel" ? {} : { ipc: () => {} }),
			});
			try {
				if (mode === "disconnect") child.disconnect();
				if (mode === "invalid") child.send("not-a-release");
				expect(await child.exited).toBe(1);
				expect(await fs.exists(marker)).toBe(false);
			} finally {
				child.kill();
				await child.exited;
				await fs.rm(dir, { recursive: true, force: true });
			}
		}, 5000);
	}
	it("preserves pipe stdin and caller disconnect handling on normal release", async () => {
		let disconnects = 0;
		const child = spawn(["/bin/cat"], {
			subreaper: true,
			stdin: "pipe",
			ipc: () => {},
			onDisconnect: () => {
				disconnects++;
			},
		});
		child.proc.stdin.write("startup-input\n");
		await child.proc.stdin.end();
		const result = await child.wait();
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("startup-input\n");
		expect(disconnects).toBe(1);
	}, 5000);
	it("fails closed when sending the release throws", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-start-send-"));
		const marker = path.join(dir, "ran");
		const child = spawn(["/bin/sh", "-c", `echo ran > '${marker}'`], { subreaper: true });
		const send = spyOn(child.proc, "send").mockImplementation(() => {
			throw new Error("send unavailable");
		});
		try {
			expect(await child.wait().catch((error: unknown) => error)).toBeInstanceOf(AbortError);
			expect(send).toHaveBeenCalledTimes(1);
			expect(await fs.exists(marker)).toBe(false);
		} finally {
			send.mockRestore();
			child.kill(undefined, -1);
			await child.proc.exited;
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 5000);
	for (const cancel of [false, true]) {
		it(`lets an unref caller exit after ${cancel ? "cancellation" : "normal completion"}`, async () => {
			const script = `import { spawn, AbortError } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils/ptree"))};
const child = spawn(["/bin/sh", "-c", "printf done"], {subreaper:true});
child.proc.unref();
${cancel ? 'child.kill(new AbortError(new Error("stop"), ""));' : ""}
const result = await child.wait().catch(error => error);
if (${cancel} ? !(result instanceof AbortError) : result.stdout !== "done") throw new Error("unexpected outcome");
console.log("settled");`;
			const caller = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
			const timeout = setTimeout(() => caller.kill(), 4000);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					caller.exited,
					new Response(caller.stdout).text(),
					new Response(caller.stderr).text(),
				]);
				expect(exitCode, stderr).toBe(0);
				expect(stdout).toBe("settled\n");
			} finally {
				clearTimeout(timeout);
				caller.kill();
				await caller.exited;
			}
		}, 5000);
	}
});
