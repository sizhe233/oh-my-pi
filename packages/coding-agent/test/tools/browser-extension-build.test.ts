import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const assetsPath = "packages/coding-agent/src/tools/browser/relay/extension-assets";

async function readAssets(directory: string): Promise<Record<string, Uint8Array>> {
	const entries = await fs.readdir(directory);
	return Object.fromEntries(
		await Promise.all(
			entries.map(async name => [name, new Uint8Array(await Bun.file(path.join(directory, name)).arrayBuffer())]),
		),
	);
}

it("builds the committed relay assets identically from repository, package and unrelated directories", async () => {
	await using fixture = await TempDir.create("@omp-extension-build-");
	await using unrelated = await TempDir.create("@omp-extension-caller-");
	for (const relative of [
		"LICENSE",
		"packages/coding-agent/package.json",
		"packages/coding-agent/src/tools/browser/relay/protocol.ts",
		"packages/browser-relay/scripts/build-extension.ts",
	]) {
		await Bun.write(fixture.join(relative), Bun.file(path.join(repoRoot, relative)));
	}
	await fs.cp(
		path.join(repoRoot, "packages/browser-relay/extension"),
		fixture.join("packages/browser-relay/extension"),
		{
			recursive: true,
		},
	);
	const expected = await readAssets(path.join(repoRoot, assetsPath));
	const directBundle = unrelated.join("background.js");
	await $`${process.execPath} build extension/background.ts --target browser --outfile ${directBundle}`
		.cwd(fixture.join("packages/browser-relay"))
		.quiet();
	const directBytes: Uint8Array = new Uint8Array(await Bun.file(directBundle).arrayBuffer());
	expect(directBytes).toEqual(expected["background.js.txt"]);
	const script = fixture.join("packages/browser-relay/scripts/build-extension.ts");
	for (const cwd of [fixture.path(), fixture.join("packages/browser-relay"), unrelated.path()]) {
		await $`${process.execPath} ${script}`.cwd(cwd).quiet();
		expect(await readAssets(fixture.join(assetsPath))).toEqual(expected);
	}
});
