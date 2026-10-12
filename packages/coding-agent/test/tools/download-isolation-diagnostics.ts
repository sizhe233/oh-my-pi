import * as fs from "node:fs";
import * as path from "node:path";

const LIMITS = { requests: 16, entriesPerDirectory: 16, bytesPerFile: 128, timeMs: 200 } as const;

type DirectoryLabel = "first" | "second";
type OwnedDirectories = Record<DirectoryLabel, string>;

interface DownloadLocation {
	directory: DirectoryLabel | "outside-owned-directories";
	basename: string;
}

interface FixtureRequest {
	path: "/file";
	sequence: number;
	tab: string;
	elapsedMs: number;
}

interface DownloadIsolationEvidence {
	phase: string;
	failedAt: string;
	limits: { requests: number; entriesPerDirectory: number; bytesPerFile: number; timeMs: number };
	requests: FixtureRequest[];
	droppedRequests: number;
	completedPath?: DownloadLocation;
	outcome: "observed" | "timed-out" | "observation-error";
	snapshots?: unknown[];
	errorCode?: string;
}

export interface DownloadIsolationDiagnostics {
	recordRequest(sequence: number, tab: string | null): void;
	recordCompletedPath(file: string): void;
	capture(phase: string): Promise<DownloadIsolationEvidence>;
}

function safeName(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, 128);
}

function errorCode(error: unknown): string {
	const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
	return typeof code === "string" ? safeName(code) : "observation-error";
}

function location(file: string, directories: OwnedDirectories): DownloadLocation {
	const resolved = path.resolve(file);
	for (const label of ["first", "second"] as const) {
		const relative = path.relative(directories[label], resolved);
		if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
			return { directory: label, basename: safeName(path.basename(resolved)) };
		}
	}
	return { directory: "outside-owned-directories", basename: safeName(path.basename(resolved)) };
}

async function snapshotEntry(directory: string, name: string, signal: AbortSignal) {
	signal.throwIfAborted();
	const file = path.join(directory, name);
	const stat = await fs.promises.lstat(file);
	const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
	const metadata = { name: safeName(name), kind, size: stat.size };
	if (kind !== "file") return metadata;
	signal.throwIfAborted();
	// No traversal, and never read a symlink or an unexpectedly replaced file.
	const handle = await fs.promises.open(
		file,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
	);
	try {
		signal.throwIfAborted();
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
			return { ...metadata, observation: "entry-changed-before-read" };
		}
		signal.throwIfAborted();
		const bytes = Buffer.alloc(LIMITS.bytesPerFile);
		const read = await handle.read(bytes, 0, bytes.length, 0);
		signal.throwIfAborted();
		const after = await handle.stat();
		const prefix = bytes.subarray(0, read.bytesRead);
		const text = prefix.toString("utf8");
		const stableSize = opened.size === after.size && opened.mtimeMs === after.mtimeMs;
		const complete = stableSize && read.bytesRead === after.size;
		const knownFixture = complete && /^tab (first|second), download [1-9][0-9]*\n$/.test(text);
		return {
			...metadata,
			sizeAfterRead: after.size,
			bytesRead: read.bytesRead,
			stableSizeAndMtime: stableSize,
			hashScope: complete ? "observed-full-file" : "first-up-to-128-bytes",
			sha256: Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(prefix))),
				byte => byte.toString(16).padStart(2, "0"),
			).join(""),
			...(knownFixture ? { fixtureText: text } : {}),
		};
	} finally {
		await handle.close();
	}
}

async function snapshotDirectory(label: DirectoryLabel, directory: string, signal: AbortSignal) {
	signal.throwIfAborted();
	const stat = await fs.promises.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) return { directory: label, observation: "owned-directory-changed" };
	signal.throwIfAborted();
	const handle = await fs.promises.opendir(directory, { bufferSize: 1 });
	const entries: unknown[] = [];
	let endObserved = false;
	try {
		for (let index = 0; index < LIMITS.entriesPerDirectory; index++) {
			signal.throwIfAborted();
			const entry = await handle.read();
			if (!entry) {
				endObserved = true;
				break;
			}
			try {
				entries.push(await snapshotEntry(directory, entry.name, signal));
			} catch (error) {
				if (signal.aborted) throw error;
				entries.push({ name: safeName(entry.name), observationError: errorCode(error) });
			}
		}
	} finally {
		await handle.close();
	}
	return { directory: label, entries, endObserved, limitReached: !endObserved };
}

/** Read-only, failure-only evidence for one disposable real-browser download fixture. */
export function createDownloadIsolationDiagnostics(directories: OwnedDirectories): DownloadIsolationDiagnostics {
	const started = performance.now();
	const requests: FixtureRequest[] = [];
	let droppedRequests = 0;
	let completedPath: DownloadLocation | undefined;
	return {
		recordRequest(sequence: number, tab: string | null): void {
			if (requests.length === LIMITS.requests) {
				droppedRequests++;
				return;
			}
			requests.push({
				path: "/file",
				sequence,
				tab: tab === "first" || tab === "second" ? tab : "other",
				elapsedMs: performance.now() - started,
			});
		},
		recordCompletedPath(file: string): void {
			completedPath = location(file, directories);
		},
		async capture(phase: string) {
			const failedAt = new Date().toISOString();
			const base = {
				phase,
				failedAt,
				limits: LIMITS,
				requests: requests.map(request => ({ ...request })),
				droppedRequests,
				completedPath,
			};
			const controller = new AbortController();
			const expired = Promise.withResolvers<never>();
			const timer = setTimeout(() => {
				controller.abort();
				expired.reject(new Error("observation-timeout"));
			}, LIMITS.timeMs);
			const pending = (async (): Promise<DownloadIsolationEvidence> => {
				const snapshots: unknown[] = [];
				for (const label of ["first", "second"] as const) {
					try {
						snapshots.push(await snapshotDirectory(label, directories[label], controller.signal));
					} catch (error) {
						if (controller.signal.aborted) throw error;
						snapshots.push({ directory: label, observationError: errorCode(error) });
					}
				}
				return { ...base, outcome: "observed", snapshots };
			})();
			try {
				return await Promise.race([pending, expired.promise]);
			} catch (error) {
				return {
					...base,
					outcome: controller.signal.aborted ? "timed-out" : "observation-error",
					errorCode: errorCode(error),
				};
			} finally {
				clearTimeout(timer);
				controller.abort();
			}
		},
	};
}
