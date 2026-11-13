import { hasRestorableTurn } from "../session/exit-diagnostics";
import type { SessionEntry } from "../session/session-entries";
import { hasPendingStepDispatch } from "./steps";

interface RestoreBranch {
	key: string;
	parent: string | null;
	entries: readonly SessionEntry[];
}

/** Isolate unreadable progress to its owner subtree; independent roots remain restorable. */
export function selectRestorableTaskBranches(branches: readonly RestoreBranch[]): {
	interrupted: string[];
	excluded: Set<string>;
	failures: Array<{ key: string; error: unknown }>;
} {
	const interrupted: string[] = [];
	const excluded = new Set<string>();
	const failures: Array<{ key: string; error: unknown }> = [];
	const available = new Set(branches.map(branch => branch.key));
	const ordered = branches.toSorted((left, right) => left.key.split("/").length - right.key.split("/").length);
	for (const branch of ordered) {
		if (branch.parent && (!available.has(branch.parent) || excluded.has(branch.parent))) {
			excluded.add(branch.key);
			continue;
		}
		try {
			const pending = hasPendingStepDispatch(branch.entries);
			if (hasRestorableTurn(branch.entries) || pending) interrupted.push(branch.key);
		} catch (error) {
			excluded.add(branch.key);
			failures.push({ key: branch.key, error });
		}
	}
	return { interrupted, excluded, failures };
}
