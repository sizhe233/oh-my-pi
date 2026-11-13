import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ptree, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { JsExecutorOptions } from "../../src/eval/js/executor";
import { installJsPackages, resolveJsPackageEnvironment } from "../../src/eval/js/package-installer";
import type { ToolSession } from "../../src/tools";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

function makeSession(cwd: string, evalSessionId: string, options?: { autoProvision?: boolean }): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": options?.autoProvision ?? true,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => evalSessionId,
		getEvalSessionId: () => evalSessionId,
	};
}

function executorOptions(session: ToolSession, sessionId: string): JsExecutorOptions {
	return { cwd: session.cwd, sessionId, session };
}

function canResolve(specifier: string, fromDir: string): boolean {
	try {
		Bun.resolveSync(specifier, fromDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Picks a package OMP itself resolves but none of `roots` can. Prefers `@babel/parser`; a stray
 * `node_modules` above a root (e.g. `npm i` run in the Windows profile dir) legitimately puts
 * it in that root's ancestry, so fall back to any other package installed for OMP.
 */
function ompOnlyPackage(...roots: string[]): string {
	const ompDir = path.resolve(import.meta.dir, "../..");
	const repoModules = path.resolve(ompDir, "../../node_modules");
	const candidates = [
		"@babel/parser",
		...fsSync.readdirSync(repoModules).filter(name => !name.startsWith(".") && !name.startsWith("@")),
	];
	const picked = candidates.find(name => canResolve(name, ompDir) && !roots.some(root => canResolve(name, root)));
	if (!picked) throw new Error(`Every OMP dependency is also resolvable from ${roots.join(" or ")}`);
	return picked;
}

describe("persistent JavaScript package environments", () => {
	const managedRoots: string[] = [];

	afterEach(async () => {
		await disposeAllVmContexts();
		await Promise.all(
			managedRoots
				.splice(0)
				.flatMap(root => [
					fs.rm(root, { recursive: true, force: true }),
					fs.rm(`${root}.install.lock`, { force: true }),
				]),
		);
	});

	it("refuses an implicit managed environment bootstrap when auto-provisioning is disabled", async () => {
		using workspace = TempDir.createSync("@omp-js-package-policy-");
		const settingsState = beginSettingsTest();
		const agentDir = workspace.join("agent");
		setAgentDir(agentDir);
		try {
			const sessionId = `js-package-policy:${crypto.randomUUID()}`;
			const session = makeSession(workspace.path(), sessionId, { autoProvision: false });
			const environment = resolveJsPackageEnvironment(workspace.path());
			managedRoots.push(environment.root);

			const result = await executeJs("", {
				...executorOptions(session, sessionId),
				packages: ["package-that-must-not-be-fetched"],
			});
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("eval.autoProvision is disabled");
			await expect(fs.access(path.join(environment.root, "package.json"))).rejects.toBeDefined();
			await expect(fs.access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			restoreSettingsTestState(settingsState);
		}
	});

	it("keeps explicit installs into an existing managed environment available with auto-provisioning disabled", async () => {
		using workspace = TempDir.createSync("@omp-js-existing-policy-");
		const settingsState = beginSettingsTest();
		setAgentDir(workspace.join("agent"));
		try {
			const environment = resolveJsPackageEnvironment(workspace.path());
			const packageDir = workspace.join("fixture-package");
			await Bun.write(
				path.join(packageDir, "package.json"),
				JSON.stringify({ name: "omp-test-local-policy", version: "1.0.0" }),
			);
			await Bun.write(
				path.join(environment.root, "package.json"),
				JSON.stringify({ private: true, dependencies: {} }),
			);
			await installJsPackages({ cwd: workspace.path(), packages: [`file:${packageDir}`], autoProvision: false });
			const installed = await Bun.file(
				path.join(environment.root, "node_modules/omp-test-local-policy/package.json"),
			).json();
			expect(installed.name).toBe("omp-test-local-policy");
			expect(installed.version).toBe("1.0.0");
		} finally {
			restoreSettingsTestState(settingsState);
		}
	});

	it.each(["manifest disappears", "request is cancelled"] as const)(
		"does not start an install when %s after the read-only provisioning check",
		async scenario => {
			using workspace = TempDir.createSync("@omp-js-policy-race-");
			const settingsState = beginSettingsTest();
			setAgentDir(workspace.join("agent"));
			try {
				const environment = resolveJsPackageEnvironment(workspace.path());
				const manifest = path.join(environment.root, "package.json");
				await Bun.write(manifest, JSON.stringify({ private: true, dependencies: {} }));
				const controller = new AbortController();
				const access = fsSync.promises.access;
				let intercepted = false;
				vi.spyOn(fsSync.promises, "access").mockImplementation(async (...args) => {
					await access(...args);
					if (args[0] !== manifest || intercepted) return;
					intercepted = true;
					if (scenario === "manifest disappears") await fs.rm(manifest);
					else controller.abort(new Error("cancelled after policy read"));
				});
				const mkdir = vi.spyOn(fsSync.promises, "mkdir");
				const install = vi.spyOn(ptree, "exec").mockRejectedValue(new Error("unexpected package installer"));
				await expect(
					installJsPackages({
						cwd: workspace.path(),
						packages: ["package-that-must-not-be-fetched"],
						autoProvision: false,
						signal: controller.signal,
					}),
				).rejects.toThrow(
					scenario === "manifest disappears" ? "eval.autoProvision is disabled" : "cancelled after policy read",
				);
				expect(intercepted).toBe(true);
				expect(install).not.toHaveBeenCalled();
				if (scenario === "request is cancelled") expect(mkdir).not.toHaveBeenCalled();
				await expect(access(`${environment.root}.install.lock`)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				restoreSettingsTestState(settingsState);
			}
		},
	);

	it("resolves file imports from the filename while preserving cwd and repeat execution", async () => {
		using workspace = TempDir.createSync("@omp-js-file-workspace-");
		using scriptDir = TempDir.createSync("@omp-js-file-script-");
		const filename = path.join(scriptDir.path(), "loaded.ts");
		const source = [
			'import { amount } from "./sibling.ts";',
			"globalThis.fileLoadCount = (globalThis.fileLoadCount ?? 0) + 1;",
			"var fileLoadedValue = fileSeed + amount;",
			"function fileAnswer() { return fileLoadedValue; }",
			"var fileObservedCwd = process.cwd();",
		].join("\n");
		await Bun.write(path.join(scriptDir.path(), "sibling.ts"), "export const amount = 2;\n");
		await Bun.write(filename, source);

		const sessionId = `js-file:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = executorOptions(session, sessionId);
		await executeJs("var fileSeed = 10;", options);
		const first = await executeJs(source, { ...options, filename });
		const second = await executeJs(source, { ...options, filename });
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(first.output).not.toContain(source);
		expect(second.output).not.toContain(source);

		const reloadSource = "fileLoadedValue += 1; fileLoadedValue;";
		await Bun.write(filename, reloadSource);
		const reloaded = await executeJs(reloadSource, { ...options, filename });
		expect(reloaded.output.trim()).toBe("13");

		const retained = await executeJs("JSON.stringify([fileAnswer(), fileObservedCwd, fileLoadCount])", options);
		expect(JSON.parse(retained.output.trim())).toEqual([13, await fs.realpath(workspace.path()), 2]);
	});

	it("does not resolve a missing project package from OMP's own dependencies", async () => {
		// Dynamic import is the behavior under test: a static import would be
		// resolved by this test module's own dependency graph.
		using workspace = TempDir.createSync("@omp-js-package-missing-");
		// The eval falls back to the managed environment, which lives under the agent dir (by default in HOME), so a
		// `node_modules` beside HOME would supply the package. Root the agent dir in the workspace instead.
		const settingsState = beginSettingsTest();
		setAgentDir(workspace.join("agent"));
		try {
			const sessionId = `js-package-missing:${crypto.randomUUID()}`;
			const session = makeSession(workspace.path(), sessionId);
			// The package must be missing from both roots the eval resolves from: the project and its fallback.
			const { packageRoot } = resolveJsPackageEnvironment(workspace.path());
			if (packageRoot === undefined) throw new Error("The managed JS package environment has no fallback root");
			const specifier = ompOnlyPackage(workspace.path(), packageRoot);
			const result = await executeJs(
				`await import(${JSON.stringify(specifier)})`,
				executorOptions(session, sessionId),
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("JS package environment fallback");
		} finally {
			restoreSettingsTestState(settingsState);
		}
	});
});
