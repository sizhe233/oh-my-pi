import { describe, expect, test } from "bun:test";
import { hasPendingStepDispatch, readStepProgress } from "../../src/task/steps";
import type { FileEntry } from "../../src/session/session-entries";
function records(data: unknown[]): FileEntry[] {
	return data.map(value => ({ type: "custom", customType: "task-steps", data: value }) as FileEntry);
}
describe("persisted task step boundaries", () => {
	for (const [name, data] of [
		["fractional counter", [{ prompts: ["one", "two"], sent: 1.5 }]],
		["counter beyond last prompt", [{ prompts: ["one", "two"], sent: 3 }]],
		["nonfinite counter", [{ prompts: ["one", "two"], sent: Infinity }]],
		["empty prompt list", [{ prompts: [], sent: 1 }]],
		["blank prompt", [{ prompts: [" "], sent: 1 }]],
		["regressing counter", [{ prompts: ["one", "two"], sent: 2 }, { sent: 1 }]],
		["orphan counter", [{ sent: 1 }]],
		["non-record payload", [null]],
		["missing counter", [{ prompts: ["one"] }]],
		[
			"rewritten prompt chain",
			[
				{ prompts: ["one", "two"], sent: 1 },
				{ prompts: ["other", "two"], sent: 1 },
			],
		],
	] as const) {
		test(`rejects ${name} instead of skipping or replaying work`, () => {
			expect(() => readStepProgress(records([...data]))).toThrow();
		});
	}
	test("old non-stepped transcript remains non-stepped", () => expect(readStepProgress([])).toBeUndefined());
	test("valid progress preserves remaining work", () => {
		const progress = readStepProgress(records([{ prompts: ["one", "two", "three"], sent: 1 }, { sent: 2 }]));
		expect(progress?.prompts.slice(progress.sent)).toEqual(["three"]);
	});
});

describe("task step dispatch recovery", () => {
	const initial = () =>
		records([
			{ prompts: ["one", "two", "three"], sent: 1 },
			{ sent: 1, pending: 2 },
		]);
	const user = (content: string): FileEntry =>
		({ type: "message", message: { role: "user", content, timestamp: 1 } }) as FileEntry;
	test("failure before insertion leaves the next step unsent", () => {
		expect(readStepProgress(initial())?.sent).toBe(1);
		expect(hasPendingStepDispatch(initial())).toBe(true);
	});
	test("persisted input counts even if the model turn later throws", () => {
		expect(readStepProgress([...initial(), user("two")])?.sent).toBe(2);
		expect(hasPendingStepDispatch([...initial(), user("two")])).toBe(false);
	});
	test("repeated pre-insertion attempts do not skip the missing step", () => {
		expect(readStepProgress([...initial(), ...records([{ sent: 1, pending: 2 }]), user("two")])?.sent).toBe(2);
	});
	test("an inserted step followed by a failed dispatch keeps only the last step pending", () => {
		expect(readStepProgress([...initial(), user("two"), ...records([{ sent: 2, pending: 3 }])])?.sent).toBe(2);
	});
	test("ambiguous or transformed user input refuses replay", () => {
		expect(() => readStepProgress([...initial(), user("rewritten two")])).toThrow("Cannot identify");
	});
	test("a skipped dispatch refuses restoration", () => {
		expect(() => readStepProgress([...initial(), ...records([{ sent: 2, pending: 3 }])])).toThrow();
	});
});

test("remaining legacy steps alone do not reopen a failed or completed run", () => {
	expect(hasPendingStepDispatch(records([{ prompts: ["one", "two"], sent: 1 }]))).toBe(false);
});
