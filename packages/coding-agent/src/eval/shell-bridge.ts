/** Reserved upstream helper: refused until it shares the normal Bash authorization and lifecycle. */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `sh` helper across both runtimes. */
export const EVAL_SHELL_BRIDGE_NAME = "__shell__";

export interface EvalShellBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** A finished `sh` command; the kernel helper raises `ShellError` unless `exitCode` is 0. */
export interface EvalShellResult {
	/** Combined stdout and stderr, ANSI-stripped. */
	output: string;
	/** Undefined when the command hit its `timeout`. */
	exitCode?: number;
	timedOut?: boolean;
}

/** Refuse all callers, including forged host bridge requests, without allocating shell state. */
export async function runEvalShell(_args: unknown, _options: EvalShellBridgeOptions): Promise<EvalShellResult> {
	throw new ToolError("sh() is unavailable in this fork; use the policy-checked bash tool instead.");
}
