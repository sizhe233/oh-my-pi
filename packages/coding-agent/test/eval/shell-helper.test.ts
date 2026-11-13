import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let temp: TempDir;
let settingsState: SettingsTestState;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-shell-helper-");
	setAgentDir(path.join(temp.path(), "agent"));
	await fs.mkdir(path.join(temp.path(), "sub"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	AgentStorage.close();
	temp.removeSync();
});

/** Existing Eval session settings do not grant a separate unwrapped shell authority. */
function makeSession(): ToolSession {
	const id = `shell-helper-${crypto.randomUUID()}`;
	return {
		cwd: temp.path(),
		hasUI: false,
		skills: [],
		settings: Settings.isolated({
			"eval.autoProvision": false,
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 10,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
	};
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe("fork eval shell boundary", () => {
	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: refuses sh before a command can write a file`,
			async () => {
				const marker = path.join(temp.path(), "must-not-exist");
				const command = `printf forbidden > '${marker}'`;
				const code = language === "js" ? `await sh(${JSON.stringify(command)})` : `sh(${JSON.stringify(command)})`;
				const result = await new EvalTool(makeSession()).execute("denied-shell", { language, code, timeout: 30 });
				expect(result.details?.cells?.[0]?.status).toBe("error");
				expect(result.content.some(part => part.type === "text" && part.text.includes("sh() is unavailable"))).toBe(
					true,
				);
				expect(await Bun.file(marker).exists()).toBe(false);
			},
		);
	}

	it("rejects a forged host bridge call even for an idless session", async () => {
		const session = makeSession();
		delete session.getSessionId;
		const marker = path.join(temp.path(), "forged-marker");
		await expect(
			callSessionTool("__shell__", { command: `printf forbidden > '${marker}'` }, { session }),
		).rejects.toThrow("sh() is unavailable");
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});
