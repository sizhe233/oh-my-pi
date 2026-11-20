import { expect, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

test("stages parents without slots, then admits at most one ready job and publishes the admission", async () => {
	const manager = new AsyncJobManager({ maxRunningJobs: 1 });
	const childDone = Promise.withResolvers<void>();
	const parentDone = Promise.withResolvers<void>();
	const order: string[] = [];
	const changes: string[] = [];
	let maxObservedRunning = 0;
	const unlisten = manager.onJobsChanged(() => {
		let running = 0;
		for (const id of ["parent", "child", "peer"]) {
			const job = manager.getJob(id);
			if (job?.status === "running" && !job.queued) {
				running++;
				changes.push(id);
			}
		}
		maxObservedRunning = Math.max(maxObservedRunning, running);
	});
	try {
		manager.register(
			"task",
			"parent",
			async () => {
				order.push("parent");
				await parentDone.promise;
				return "parent result";
			},
			{
				id: "parent",
				foreground: true,
				waitForCapacity: true,
				beforeStart: async () => {
					const child = manager.getJob("child");
					expect(child).toBeDefined();
					await child!.promise;
				},
			},
		);
		manager.register(
			"task",
			"child",
			async () => {
				order.push("child");
				await childDone.promise;
				return "child result";
			},
			{ id: "child", foreground: true, waitForCapacity: true },
		);
		await scheduler.yield();
		expect(order).toEqual(["child"]);
		expect(manager.getJob("parent")?.queued).toBe(true);
		expect(changes).toContain("child");
		manager.register(
			"task",
			"peer",
			async () => {
				order.push("peer");
				return "peer result";
			},
			{ id: "peer", foreground: true, waitForCapacity: true },
		);
		await scheduler.yield();
		expect(order).toEqual(["child"]);
		expect(manager.getJob("peer")?.queued).toBe(true);
		childDone.resolve();
		await scheduler.yield();
		expect(order.length).toBeGreaterThanOrEqual(2);
		parentDone.resolve();
		await scheduler.yield();
		expect(order).toHaveLength(3);
		expect(maxObservedRunning).toBe(1);
		expect(order.slice(1).sort()).toEqual(["parent", "peer"]);
		expect(changes).toContain("parent");
		expect(changes).toContain("peer");
	} finally {
		unlisten();
		childDone.resolve();
		parentDone.resolve();
		await manager.dispose();
	}
});

test("cancels a queued dependency wait even before its callback returns", async () => {
	const manager = new AsyncJobManager({ maxRunningJobs: 1 });
	const dependency = Promise.withResolvers<void>();
	const preparing = Promise.withResolvers<void>();
	let started = false;
	try {
		const id = manager.register(
			"task",
			"pending dependency",
			async () => {
				started = true;
				return "not reached";
			},
			{
				waitForCapacity: true,
				beforeStart: () => {
					preparing.resolve();
					return dependency.promise;
				},
			},
		);
		await preparing.promise;
		expect(manager.cancel(id)).toBe(true);
		await scheduler.yield();
		expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(manager.getJob(id)?.endTime).toBeDefined();
		expect(started).toBe(false);
	} finally {
		dependency.resolve();
		await manager.dispose();
	}
});

test("a synchronous admission observer can cancel before the runner starts", async () => {
	const manager = new AsyncJobManager({ maxRunningJobs: 1 });
	let started = false;
	const unlisten = manager.onJobsChanged(() => {
		const job = manager.getJob("observed");
		if (job?.status === "running" && !job.queued) manager.cancel(job.id);
	});
	try {
		const id = manager.register(
			"task",
			"observed",
			async () => {
				started = true;
				return "not reached";
			},
			{ id: "observed", waitForCapacity: true },
		);
		await manager.getJob(id)?.promise;
		expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(started).toBe(false);
	} finally {
		unlisten();
		await manager.dispose();
	}
});
