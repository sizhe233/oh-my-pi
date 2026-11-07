import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

for (const explicit of [false, true]) {
	it.skipIf(!explicit && process.platform !== "linux" && process.platform !== "darwin")(
		`native grammar discovery uses the ${explicit ? "explicit" : "initialized XDG cache"} installer root`,
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grammar-root-"));
			const cache = path.join(root, "cache");
			await fs.mkdir(path.join(cache, "omp"), { recursive: true });
			const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cache };
			for (const key of ["PI_NATIVES_DIR", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"])
				delete env[key];
			if (explicit) env.PI_NATIVES_DIR = path.join(root, "explicit");
			const script = `
import {__ompSetGrammarDir, wasmGrammarFor} from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-natives"))};
import {getNativeGrammarsDir} from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))};
import {ensureGrammar, ensureGrammars} from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/utils/grammars"))};
import {mkdir} from "node:fs/promises";
import path from "node:path";
const dir=getNativeGrammarsDir();
const expected=${JSON.stringify(path.join(explicit ? path.join(root, "explicit") : path.join(cache, "omp", "natives"), "grammars"))};
if(dir!==expected) throw new Error("wrong installer root: "+dir);
const info=wasmGrammarFor({lang:"tlaplus"});
if(!info) throw new Error("missing tlaplus metadata");
await mkdir(dir,{recursive:true});
// Discovery tests path visibility only; real grammar integrity/parsing has separate coverage.
await Bun.write(path.join(dir,info.file),new Uint8Array([0,97,115,109,1,0,0,0]));
for (const batch of [false,true]) {
 __ompSetGrammarDir(${JSON.stringify(path.join(root, "wrong"))});
 if(wasmGrammarFor({lang:"tlaplus"})?.installed) throw new Error("invalid precondition");
 const ok=batch?await ensureGrammars(["tlaplus"]):await ensureGrammar({lang:"tlaplus"});
 if(!ok || !wasmGrammarFor({lang:"tlaplus"})?.installed) throw new Error("native cannot discover installer cache");
}
console.log("cache-visible");`;
			const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
			const timeout = setTimeout(() => child.kill(), 8000);
			try {
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(code, stderr).toBe(0);
				expect(stdout).toBe("cache-visible\n");
			} finally {
				clearTimeout(timeout);
				child.kill();
				await child.exited;
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		10000,
	);
}
