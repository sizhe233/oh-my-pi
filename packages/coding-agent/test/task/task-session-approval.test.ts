import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";

describe("task session approval expiry", () => {
	let directory: string;
	const executions: ExecutorOptions[] = [];

	beforeEach(async () => {
		// Keep the real session cwd stable on platforms where tmpdir is a symlink.
		directory = await fs.promises.realpath(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-task-session-approval-")),
		);
		executions.length = 0;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Complete the task.", source: "bundled" }],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executions.push(options);
			const progress: AgentProgress = {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				status: "completed",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 0,
				cost: 0,
				durationMs: 1,
			};
			options.onProgress?.(progress);
			return { ...progress, exitCode: 0, output: "Completed.", stderr: "", truncated: false };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	async function createWrapper(select: ExtensionUIContext["select"], stepsEnabled: boolean) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.steps": stepsEnabled,
			"tools.approvalMode": "always-ask",
		});
		const tool = await TaskTool.create({
			cwd: directory,
			hasUI: true,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
		} as unknown as ToolSession);
		const sessionManager = SessionManager.inMemory(directory);
		const modelRegistry = {} as ModelRegistry;
		const runner = new ExtensionRunner([], new ExtensionRuntime(), directory, sessionManager, modelRegistry);
		runner.initialize(
			{} as Parameters<ExtensionRunner["initialize"]>[0],
			{} as Parameters<ExtensionRunner["initialize"]>[1],
			undefined,
			{ select } as ExtensionUIContext,
		);
		const wrapper = new ExtensionToolWrapper(
			{
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				approval: tool.approval,
				formatApprovalDetails: tool.formatApprovalDetails,
				execute: tool.execute.bind(tool),
			},
			runner,
		);
		const context: AgentToolContext = {
			settings,
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => undefined,
		};
		return { wrapper, context, runner, tool };
	}

	it.each([
		{ input: "task", phase: "pending" },
		{ input: "task", phase: "resolved" },
		{ input: "steps", phase: "pending" },
		{ input: "steps", phase: "resolved" },
	])("rejects $input dispatch and session grants when approval expires during $phase", async ({ input, phase }) => {
		const args =
			input === "steps"
				? { steps: ["Inspect the assignment.", "Report the result."] }
				: { task: "Complete the assignment." };
		const { wrapper, context, runner } = await createWrapper(async (_title, options) => {
			if (phase === "pending") runner.clearSessionApprovals();
			const answer = options.find(
				(option): option is string => typeof option === "string" && option.endsWith("for this session"),
			);
			expect(answer).toBeDefined();
			return answer;
		}, input === "steps");
		if (phase === "resolved") {
			vi.spyOn(runner, "hasHandlers").mockImplementation(name => name === "tool_approval_resolved");
			const originalEmit: typeof runner.emit = runner.emit.bind(runner);
			vi.spyOn(runner, "emit").mockImplementation(event => {
				if (event.type === "tool_approval_resolved") runner.clearSessionApprovals();
				return originalEmit(event);
			});
		}
		await expect(
			wrapper.execute(`expired-task-${input}-${phase}`, args, undefined, undefined, context),
		).rejects.toThrow("session changed");
		expect(executions).toEqual([]);
		expect(runner.sessionApprovalKeys()).toEqual([]);
	});
});
