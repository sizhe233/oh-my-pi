import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sanitizeText, truncate } from "@oh-my-pi/pi-utils";

export const CHROMIUM_DIAGNOSTIC_LIMITS = {
	timeMs: 200,
	bytes: 64 * 1024,
	processes: 16,
	tasks: 32,
	pathLookups: 16,
} as const;

export interface ChromiumFailureContext {
	rootPid: number;
	executable: string;
	port: number;
	failureAtMs: number;
}

interface ProcessSnapshot {
	pid: number;
	ppid: number;
	state: string;
	executableBasename?: string;
}

export interface ChromiumFailureSnapshot {
	failureAtMs: number;
	startedAtMs: number;
	finishedAtMs: number;
	rootPid: number;
	partial: boolean;
	bytesRead: number;
	tasksRead: number;
	pathLookups: number;
	selectedBasename: string;
	selectedRealBasename?: string;
	processes: ProcessSnapshot[];
	listener: {
		port: number;
		loopbackIpv4: boolean | null;
		wildcardIpv4: boolean | null;
		ipv6Port: boolean | null;
	};
	issues: Array<"read" | "identity" | "limit" | "aborted">;
}

interface BoundedText {
	text: string;
	bytes: number;
	truncated: boolean;
}

interface BoundedNames {
	names: string[];
	truncated: boolean;
}

interface DiagnosticFile {
	read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;
	close: () => Promise<void>;
}

interface DiagnosticDirectory {
	read: () => Promise<{ name: string } | null>;
	close: () => Promise<void>;
}

interface DiagnosticFiles {
	open: (file: string) => Promise<DiagnosticFile>;
	opendir: (directory: string) => Promise<DiagnosticDirectory>;
	readlink: (file: string) => Promise<string>;
	realpath: (file: string) => Promise<string>;
}

export interface ChromiumProcReader {
	read: (file: string, maxBytes: number, signal: AbortSignal) => Promise<BoundedText>;
	names: (directory: string, maxEntries: number, signal: AbortSignal) => Promise<BoundedNames>;
	readlink: (file: string, signal: AbortSignal) => Promise<string>;
	realpath: (file: string, signal: AbortSignal) => Promise<string>;
}

/** Stop awaiting uncancellable filesystem calls; close resources that arrive after abort. */
async function withinSignal<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const abort = () => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", abort);
		reject(new Error("Diagnostic collection aborted"));
	};
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	void pending.then(
		value => {
			signal.removeEventListener("abort", abort);
			if (settled) {
				late?.(value);
				return;
			}
			settled = true;
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", abort);
			if (settled) return;
			settled = true;
			reject(error);
		},
	);
	return promise;
}

/** Fixed-size reads are intentional: procfs size metadata cannot bound a readFile(). */
export function createChromiumProcReader(files: DiagnosticFiles = {
	open: file => fs.open(file, "r"),
	opendir: directory => fs.opendir(directory),
	readlink: file => fs.readlink(file),
	realpath: file => fs.realpath(file),
}): ChromiumProcReader {
	const close = (resource: DiagnosticFile | DiagnosticDirectory) => {
		try {
			void resource.close().catch(() => {});
		} catch {}
	};
	return {
		async read(file, maxBytes, signal) {
			signal.throwIfAborted();
			const handle = await withinSignal(files.open(file), signal, close);
			try {
				const buffer = Buffer.alloc(maxBytes);
				let bytes = 0;
				while (bytes < maxBytes) {
					signal.throwIfAborted();
					const pending = handle.read(buffer, bytes, maxBytes - bytes, bytes);
					void pending.finally(() => {
						if (signal.aborted) close(handle);
					}).catch(() => {});
					const result = await withinSignal(pending, signal);
					if (result.bytesRead === 0) return { text: buffer.toString("utf8", 0, bytes), bytes, truncated: false };
					bytes += result.bytesRead;
				}
				return { text: buffer.toString("utf8", 0, bytes), bytes, truncated: true };
			} finally {
				close(handle);
			}
		},
		async names(directory, maxEntries, signal) {
			signal.throwIfAborted();
			const handle = await withinSignal(files.opendir(directory), signal, close);
			try {
				const names: string[] = [];
				while (names.length < maxEntries) {
					signal.throwIfAborted();
					const pending = handle.read();
					void pending.finally(() => {
						if (signal.aborted) close(handle);
					}).catch(() => {});
					const entry = await withinSignal(pending, signal);
					if (entry === null) return { names, truncated: false };
					names.push(entry.name);
				}
				return { names, truncated: true };
			} finally {
				close(handle);
			}
		},
		readlink(file, signal) {
			signal.throwIfAborted();
			return withinSignal(files.readlink(file), signal);
		},
		realpath(file, signal) {
			signal.throwIfAborted();
			return withinSignal(files.realpath(file), signal);
		},
	};
}

function basename(value: string): string {
	return truncate(sanitizeText(path.basename(value)), 128);
}

function parseStat(text: string) {
	const end = text.lastIndexOf(")");
	const fields = text.slice(end + 2).trim().split(/\s+/);
	const pid = Number(text.slice(0, text.indexOf(" ")));
	const ppid = Number(fields[1]);
	if (end < 0 || !Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !/^\d+$/.test(fields[19] ?? ""))
		throw new Error("Invalid process identity");
	return { pid, ppid, state: /^[RSDZTWtXxKPI]$/.test(fields[0] ?? "") ? fields[0]! : "?", start: fields[19] };
}

/** Observation only, after readiness already failed. Never launches or connects to a browser. */
export async function collectChromiumFailureSnapshot(
	context: ChromiumFailureContext,
	signal: AbortSignal,
	reader: ChromiumProcReader = createChromiumProcReader(),
): Promise<ChromiumFailureSnapshot> {
	const snapshot: ChromiumFailureSnapshot = {
		failureAtMs: context.failureAtMs,
		startedAtMs: Date.now(),
		finishedAtMs: 0,
		rootPid: context.rootPid,
		partial: false,
		bytesRead: 0,
		tasksRead: 0,
		pathLookups: 0,
		selectedBasename: basename(context.executable),
		processes: [],
		listener: { port: context.port, loopbackIpv4: null, wildcardIpv4: null, ipv6Port: null },
		issues: [],
	};
	const issue = (kind: ChromiumFailureSnapshot["issues"][number]) => {
		snapshot.partial = true;
		if (!snapshot.issues.includes(kind)) snapshot.issues.push(kind);
	};
	const read = async (file: string, maximum: number) => {
		signal.throwIfAborted();
		const available = Math.min(maximum, CHROMIUM_DIAGNOSTIC_LIMITS.bytes - snapshot.bytesRead);
		if (available <= 0) {
			issue("limit");
			throw new Error("Diagnostic byte limit");
		}
		const result = await withinSignal(reader.read(file, available, signal), signal);
		snapshot.bytesRead += result.bytes;
		if (result.truncated) issue("limit");
		return result;
	};
	const lookupPath = async (file: string, real: boolean) => {
		// Linux symlink targets are at most PATH_MAX bytes. Reserve that capacity before each lookup.
		if (
			snapshot.pathLookups >= CHROMIUM_DIAGNOSTIC_LIMITS.pathLookups ||
			CHROMIUM_DIAGNOSTIC_LIMITS.bytes - snapshot.bytesRead < 4096
		) {
			issue("limit");
			throw new Error("Diagnostic path limit");
		}
		signal.throwIfAborted();
		snapshot.pathLookups++;
		const value = await withinSignal(real ? reader.realpath(file, signal) : reader.readlink(file, signal), signal);
		const bytes = Buffer.byteLength(value);
		if (bytes > 4096) {
			issue("limit");
			throw new Error("Diagnostic path limit");
		}
		snapshot.bytesRead += bytes;
		return value;
	};
	const observeListener = async (family: "tcp" | "tcp6") => {
		try {
			const result = await read(`/proc/net/${family}`, 16 * 1024);
			const portHex = context.port.toString(16).toUpperCase().padStart(4, "0");
			const listening = result.text.split("\n").filter(line => {
				const columns = line.trim().split(/\s+/);
				return columns[3] === "0A" && columns[1]?.endsWith(`:${portHex}`);
			});
			const incomplete =
				result.truncated || !/^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\b/.test(result.text);
			if (incomplete) issue(result.truncated ? "limit" : "read");
			if (family === "tcp") {
				const present = (address: string) => listening.some(line => line.trim().split(/\s+/)[1] === address);
				snapshot.listener.loopbackIpv4 = present(`0100007F:${portHex}`) ? true : incomplete ? null : false;
				snapshot.listener.wildcardIpv4 = present(`00000000:${portHex}`) ? true : incomplete ? null : false;
			} else {
				snapshot.listener.ipv6Port = listening.length > 0 ? true : incomplete ? null : false;
			}
		} catch {
			issue(signal.aborted ? "aborted" : "read");
		}
	};
	try {
		if (!Number.isSafeInteger(context.rootPid) || context.rootPid <= 0) throw new Error("Invalid root PID");
		if (!Number.isInteger(context.port) || context.port < 1 || context.port > 65535) throw new Error("Invalid port");
		const pending = [{ pid: context.rootPid, parent: null as number | null }];
		const seen = new Set<number>();
		// Inspect the exact target port first; there is no network request or grace period.
		await observeListener("tcp");
		await observeListener("tcp6");
		try {
			snapshot.selectedRealBasename = basename(await lookupPath(context.executable, true));
		} catch {
			issue(signal.aborted ? "aborted" : "read");
		}
		while (pending.length > 0 && seen.size < CHROMIUM_DIAGNOSTIC_LIMITS.processes) {
			signal.throwIfAborted();
			const current = pending.shift()!;
			if (seen.has(current.pid)) continue;
			seen.add(current.pid);
			try {
				const before = parseStat((await read(`/proc/${current.pid}/stat`, 1024)).text);
				if (before.pid !== current.pid || (current.parent !== null && before.ppid !== current.parent)) {
					issue("identity");
					continue;
				}
				let executableBasename: string | undefined;
				try {
					executableBasename = basename(await lookupPath(`/proc/${current.pid}/exe`, false));
				} catch {
					issue(signal.aborted ? "aborted" : "read");
				}
				const after = parseStat((await read(`/proc/${current.pid}/stat`, 1024)).text);
				if (after.start !== before.start || after.ppid !== before.ppid || after.pid !== before.pid) {
					issue("identity");
					continue;
				}
				if (after.state === "?") issue("read");
				snapshot.processes.push({ pid: after.pid, ppid: after.ppid, state: after.state, executableBasename });
				const remainingTasks = Math.min(
					CHROMIUM_DIAGNOSTIC_LIMITS.tasks - snapshot.tasksRead,
					Math.floor((CHROMIUM_DIAGNOSTIC_LIMITS.bytes - snapshot.bytesRead) / 256),
				);
				if (remainingTasks <= 0) {
					issue("limit");
					continue;
				}
				const tasks = await withinSignal(reader.names(`/proc/${current.pid}/task`, remainingTasks, signal), signal);
				if (tasks.truncated) issue("limit");
				snapshot.tasksRead += tasks.names.length;
				snapshot.bytesRead += tasks.names.reduce((total, name) => total + Buffer.byteLength(name), 0);
				for (const task of tasks.names) {
					if (!/^\d+$/.test(task)) continue;
					let children: BoundedText;
					try {
						children = await read(`/proc/${current.pid}/task/${task}/children`, 4096);
					} catch {
						issue(signal.aborted ? "aborted" : "read");
						signal.throwIfAborted();
						continue;
					}
					for (const value of children.text.trim().split(/\s+/)) {
						const pid = Number(value);
						if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) continue;
						if (pending.length + seen.size >= CHROMIUM_DIAGNOSTIC_LIMITS.processes) {
							issue("limit");
							break;
						}
						pending.push({ pid, parent: current.pid });
					}
				}
			} catch {
				issue(signal.aborted ? "aborted" : "read");
			}
		}
		if (pending.length > 0) issue("limit");
	} catch {
		issue(signal.aborted ? "aborted" : "read");
	}
	if (signal.aborted) issue("aborted");
	snapshot.finishedAtMs = Date.now();
	return snapshot;
}
