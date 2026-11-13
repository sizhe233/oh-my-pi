import { expect, test } from "bun:test";
import type { SessionEntry } from "../../src/session/session-entries";
import { selectRestorableTaskBranches } from "../../src/task/restore-candidates";
import { expandPromptTemplate } from "../../src/config/prompt-templates";

const pending = (): SessionEntry[] =>
	[
		{ type: "custom", customType: "task-steps", data: { prompts: ["one", "two"], sent: 1 } },
		{ type: "custom", customType: "task-steps", data: { sent: 1, pending: 2 } },
	] as SessionEntry[];

test("bad step metadata excludes its dependent subtree, not a healthy independent root", () => {
	const bad = [{ type: "custom", customType: "task-steps", data: { sent: 99 } }] as SessionEntry[];
	const result = selectRestorableTaskBranches([
		{ key: "bad/child/grandchild", parent: "bad/child", entries: pending() },
		{ key: "bad/child", parent: "bad", entries: pending() },
		{ key: "bad", parent: null, entries: bad },
		{ key: "good", parent: null, entries: pending() },
	]);
	expect(result.interrupted).toEqual(["good"]);
	expect([...result.excluded].sort()).toEqual(["bad", "bad/child", "bad/child/grandchild"]);
	expect(result.failures.map(failure => failure.key)).toEqual(["bad"]);
});

test("completed coordinator remains available to an unfinished child", () => {
	const result = selectRestorableTaskBranches([
		{ key: "owner/child", parent: "owner", entries: pending() },
		{ key: "owner", parent: null, entries: [] },
	]);
	expect(result.interrupted).toEqual(["owner/child"]);
	expect(result.excluded.size).toBe(0);
});

test("expanded prompt ambiguity is isolated rather than replayed or globally fatal", () => {
	const template = { name: "second", description: "test", content: "expanded second step", source: "(project)" };
	const expanded = expandPromptTemplate("/second", [template]);
	expect(expanded).toBe("expanded second step");
	const entries = [
		{ type: "custom", customType: "task-steps", data: { prompts: ["one", "/second"], sent: 1 } },
		{ type: "custom", customType: "task-steps", data: { sent: 1, pending: 2 } },
		{ type: "message", message: { role: "user", content: expanded, timestamp: 1 } },
	] as SessionEntry[];
	const result = selectRestorableTaskBranches([
		{ key: "rewritten", parent: null, entries },
		{ key: "good", parent: null, entries: pending() },
	]);
	expect(result.interrupted).toEqual(["good"]);
	expect([...result.excluded]).toEqual(["rewritten"]);
});
