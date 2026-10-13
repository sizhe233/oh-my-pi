/** Shared persisted/live completion boundary for the yield tool. */
export function isTerminalYieldResult(event: { isError?: boolean; result?: { details?: unknown } }): boolean {
	if (event.isError) return false;
	const details = event.result?.details;
	if (!details || typeof details !== "object") return true;
	const record = details as Record<string, unknown>;
	if (record.complete === true) return true;
	return !(
		record.status === "success" &&
		Array.isArray(record.type) &&
		record.type.length > 0 &&
		record.type.every(item => typeof item === "string")
	);
}
