import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import {
	MCPAddWizard,
	type MCPAddWizardConfig,
	type MCPAddWizardDeps,
	type MCPAddWizardOAuthResult,
} from "@oh-my-pi/pi-tui/overlays/mcp-add-wizard";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

type OAuthHandler = NonNullable<ConstructorParameters<typeof MCPAddWizard>[3]>;
const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const endpoints = { authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token" };
const deps: MCPAddWizardDeps = {
	validateServerName: () => undefined,
	analyzeAuthError: () => ({ requiresAuth: true, authType: "oauth", oauth: endpoints }),
	discoverOAuthEndpoints: async () => null,
	fetchResourceMetadataScopes: async () => undefined,
};

function act(wizard: MCPAddWizard, name: string): void {
	wizard.handleNativeEvent({ type: "action", key: `sheet/actions/${name}`, act: name, mods: [] });
}

function startConnection(wizard: MCPAddWizard): void {
	wizard.handleNativeEvent({ type: "select", key: "sheet/choices-transport", item: "1" });
	for (const ch of "https://mcp.example/mcp") wizard.handleInput(ch);
	wizard.handleInput("\r");
}

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).filter(isNode).flatMap(nodes)];
}

function title(wizard: MCPAddWizard): unknown {
	const heading = nodes(wizard.describe(CX)).find(n => Reflect.get(n.p ?? {}, "role") === "omp.mcpAdd.title");
	return Reflect.get(heading?.p ?? {}, "text");
}

function snapshot(wizard: MCPAddWizard): string {
	return JSON.stringify(wizard.describe(CX));
}

function fixture(overrides: Partial<MCPAddWizardDeps> = {}) {
	const connection = Promise.withResolvers<void>();
	const oauth = Promise.withResolvers<MCPAddWizardOAuthResult>();
	const onOAuth = vi.fn<OAuthHandler>(() => oauth.promise);
	const onTest = vi.fn<(config: MCPAddWizardConfig) => Promise<void>>(() => connection.promise);
	const onCancel = vi.fn();
	const onComplete = vi.fn<(name: string, config: MCPAddWizardConfig, scope: "user" | "project") => void>();
	const onRender = vi.fn();
	const wizard = new MCPAddWizard(
		{ ...deps, ...overrides },
		onComplete,
		onCancel,
		onOAuth,
		onTest,
		onRender,
		"example",
	);
	startConnection(wizard);
	return { wizard, connection, oauth, onOAuth, onTest, onCancel, onComplete, onRender };
}

describe("MCP add wizard cancellation lifecycle", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
		setNativeRendering(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setKeybindings(KeybindingsManager.inMemory());
		setNativeRendering(false);
	});

	for (const cancel of [
		{ name: "native Cancel", run: (wizard: MCPAddWizard) => act(wizard, "cancel") },
		{ name: "Ctrl+C during connection", run: (wizard: MCPAddWizard) => wizard.handleInput("\x03") },
	]) {
		it(`${cancel.name} prevents a late auth rejection from launching host OAuth`, async () => {
			const analyze = vi.fn(deps.analyzeAuthError);
			const f = fixture({ analyzeAuthError: analyze });
			cancel.run(f.wizard);
			const closed = snapshot(f.wizard);
			f.onRender.mockClear();
			f.connection.reject(new Error("Unauthorized"));
			await Bun.sleep(0);
			expect(f.onCancel).toHaveBeenCalledTimes(1);
			expect(f.onOAuth).not.toHaveBeenCalled();
			expect(analyze).not.toHaveBeenCalled();
			expect(f.onRender).not.toHaveBeenCalled();
			expect(snapshot(f.wizard)).toBe(closed);
		});
	}

	it("Cancel ignores a late successful connection instead of mounting a scope step", async () => {
		const f = fixture();
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		f.connection.resolve();
		await Bun.sleep(1100);
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
		expect(f.onComplete).not.toHaveBeenCalled();
	});

	it("Cancel during endpoint discovery prevents subsequent metadata fetch and host OAuth", async () => {
		const discovery = Promise.withResolvers<typeof endpoints | null>();
		const fetchScopes = vi.fn(async () => "tools:read");
		const discover = vi.fn(() => discovery.promise);
		const f = fixture({
			analyzeAuthError: () => ({ requiresAuth: true, resourceMetadataUrl: "https://mcp.example/metadata" }),
			discoverOAuthEndpoints: discover,
			fetchResourceMetadataScopes: fetchScopes,
		});
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		expect(discover).toHaveBeenCalledTimes(1);
		act(f.wizard, "cancel");
		f.onRender.mockClear();
		discovery.resolve(endpoints);
		await Bun.sleep(0);
		expect(fetchScopes).not.toHaveBeenCalled();
		expect(f.onOAuth).not.toHaveBeenCalled();
		expect(f.onRender).not.toHaveBeenCalled();
	});

	it("Cancel during protected-resource metadata prevents late OAuth launch", async () => {
		const scopes = Promise.withResolvers<string | undefined>();
		const fetchScopes = vi.fn(() => scopes.promise);
		const f = fixture({
			analyzeAuthError: () => ({
				requiresAuth: true,
				authType: "oauth",
				oauth: endpoints,
				resourceMetadataUrl: "https://mcp.example/metadata",
			}),
			fetchResourceMetadataScopes: fetchScopes,
		});
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		expect(fetchScopes).toHaveBeenCalledTimes(1);
		act(f.wizard, "cancel");
		f.onRender.mockClear();
		scopes.resolve("tools:read");
		await Bun.sleep(0);
		expect(f.onOAuth).not.toHaveBeenCalled();
		expect(f.onRender).not.toHaveBeenCalled();
	});

	it("Cancel ignores discovery failure instead of mounting the manual-auth fallback", async () => {
		const discovery = Promise.withResolvers<null>();
		const discover = vi.fn(() => discovery.promise);
		const f = fixture({
			analyzeAuthError: () => ({ requiresAuth: true }),
			discoverOAuthEndpoints: discover,
		});
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		expect(discover).toHaveBeenCalledTimes(1);
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		discovery.reject(new Error("Discovery failed"));
		await Bun.sleep(0);
		expect(f.onOAuth).not.toHaveBeenCalled();
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Cancel aborts existing OAuth and ignores an already-settling result without running a health check", async () => {
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		expect(f.onOAuth).toHaveBeenCalledTimes(1);
		const signal = f.onOAuth.mock.calls[0]?.[5]?.abortSignal;
		expect(signal?.aborted).toBe(false);
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		expect(signal?.aborted).toBe(true);
		f.oauth.resolve({ credentialId: "stub-credential" });
		await Bun.sleep(0);
		expect(f.onTest).toHaveBeenCalledTimes(1);
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Closing from the OAuth render callback prevents invoking the host handler", async () => {
		const f = fixture();
		f.onRender.mockImplementation(() => act(f.wizard, "cancel"));
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		expect(f.onCancel).toHaveBeenCalledTimes(1);
		expect(f.onOAuth).not.toHaveBeenCalled();
	});

	it("Cancel suppresses a late OAuth rejection rather than showing retry on the removed wizard", async () => {
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		f.oauth.reject(new Error("Authorization failed"));
		await Bun.sleep(0);
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Cancel during the post-OAuth health check stops ANSI repainting and ignores late success", async () => {
		setNativeRendering(false);
		const health = Promise.withResolvers<void>();
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		f.onTest.mockImplementation(() => health.promise);
		f.oauth.resolve({ credentialId: "stub-credential" });
		await Bun.sleep(0);
		expect(f.onTest).toHaveBeenCalledTimes(2);
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		await Bun.sleep(100);
		health.resolve();
		await Bun.sleep(1100);
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Cancel invalidates an already-scheduled scope transition after successful OAuth", async () => {
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		f.onTest.mockImplementation(async () => {});
		f.oauth.resolve({ credentialId: "stub-credential" });
		await Bun.sleep(0);
		expect(title(f.wizard)).toBe("Checking the server");
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		await Bun.sleep(1100);
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Cancel from the ANSI health repaint stops further ticks without starting another health check", async () => {
		setNativeRendering(false);
		const health = Promise.withResolvers<void>();
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		f.onTest.mockImplementation(() => health.promise);
		let closed: string | undefined;
		let healthCallsAtClose = 0;
		f.onRender.mockClear();
		f.onRender.mockImplementation(() => {
			if (closed !== undefined || title(f.wizard) !== "Checking the server") return;
			healthCallsAtClose = f.onTest.mock.calls.length;
			act(f.wizard, "cancel");
			closed = snapshot(f.wizard);
		});
		f.oauth.resolve({ credentialId: "stub-credential" });
		try {
			await Bun.sleep(200);
			if (closed === undefined) throw new Error("Health repaint did not cancel the wizard");
			expect(f.onCancel).toHaveBeenCalledTimes(1);
			expect(healthCallsAtClose).toBe(2);
			expect(f.onTest).toHaveBeenCalledTimes(2);
			expect(f.onRender).toHaveBeenCalledTimes(1);
			expect(snapshot(f.wizard)).toBe(closed);
		} finally {
			health.resolve();
			await Bun.sleep(1100);
		}
		expect(f.onRender).toHaveBeenCalledTimes(1);
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Cancel from the native health result render leaves the closed step unchanged after the delay", async () => {
		const health = Promise.withResolvers<void>();
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		f.onTest.mockImplementation(() => health.promise);
		let closed: string | undefined;
		let healthCallsAtClose = 0;
		f.onRender.mockClear();
		f.onRender.mockImplementation(() => {
			if (closed !== undefined || title(f.wizard) !== "Checking the server") return;
			healthCallsAtClose = f.onTest.mock.calls.length;
			act(f.wizard, "cancel");
			closed = snapshot(f.wizard);
		});
		f.oauth.resolve({ credentialId: "stub-credential" });
		await Bun.sleep(0);
		// Mounting the health step does not invoke the host's render callback.
		expect(f.onRender).not.toHaveBeenCalled();
		expect(f.onCancel).not.toHaveBeenCalled();
		expect(f.onTest).toHaveBeenCalledTimes(2);
		health.resolve();
		await Bun.sleep(1100);
		if (closed === undefined) throw new Error("Health result render did not cancel the wizard");
		expect(f.onCancel).toHaveBeenCalledTimes(1);
		expect(healthCallsAtClose).toBe(2);
		expect(f.onTest).toHaveBeenCalledTimes(2);
		expect(f.onRender).toHaveBeenCalledTimes(1);
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("Closing is idempotent and later native or keyboard events cannot restart or save it", async () => {
		const f = fixture();
		act(f.wizard, "cancel");
		const closed = snapshot(f.wizard);
		f.onRender.mockClear();
		act(f.wizard, "cancel");
		f.wizard.handleInput("\x03");
		act(f.wizard, "back");
		startConnection(f.wizard);
		act(f.wizard, "next");
		f.connection.resolve();
		await Bun.sleep(0);
		expect(f.onCancel).toHaveBeenCalledTimes(1);
		expect(f.onTest).toHaveBeenCalledTimes(1);
		expect(f.onComplete).not.toHaveBeenCalled();
		expect(f.onRender).not.toHaveBeenCalled();
		expect(snapshot(f.wizard)).toBe(closed);
	});

	it("An uncancelled no-auth connection still reaches review and saves", async () => {
		const f = fixture();
		f.connection.resolve();
		await Bun.sleep(1100);
		expect(title(f.wizard)).toBe("Where should it live?");
		act(f.wizard, "next");
		act(f.wizard, "next");
		expect(f.onComplete).toHaveBeenCalledWith("example", { type: "http", url: "https://mcp.example/mcp" }, "user");
		expect(f.onCancel).not.toHaveBeenCalled();
	});

	it("An uncancelled OAuth flow checks credentials and saves their reference", async () => {
		const f = fixture();
		f.connection.reject(new Error("Unauthorized"));
		await Bun.sleep(0);
		f.onTest.mockImplementation(async () => {});
		f.oauth.resolve({ credentialId: "stub-credential", clientId: "stub-client" });
		await Bun.sleep(1100);
		expect(title(f.wizard)).toBe("Where should it live?");
		expect(f.onTest.mock.calls[1]?.[0].auth?.credentialId).toBe("stub-credential");
		act(f.wizard, "next");
		act(f.wizard, "next");
		expect(f.onComplete).toHaveBeenCalledTimes(1);
		expect(f.onComplete.mock.calls[0]?.[1].auth?.credentialId).toBe("stub-credential");
	});

	for (const stop of [
		{ name: "Native Back", run: (wizard: MCPAddWizard) => act(wizard, "back") },
		{ name: "Escape", run: (wizard: MCPAddWizard) => wizard.handleInput("\x1b") },
		{ name: "Ctrl+C during OAuth", run: (wizard: MCPAddWizard) => wizard.handleInput("\x03") },
	]) {
		it(`${stop.name} stops only the OAuth wait and retry launches a fresh unaborted attempt`, async () => {
			const f = fixture();
			f.connection.reject(new Error("Unauthorized"));
			await Bun.sleep(0);
			const first = f.onOAuth.mock.calls[0]?.[5]?.abortSignal;
			stop.run(f.wizard);
			expect(first?.aborted).toBe(true);
			const cancellation = new Error("OAuth wait cancelled");
			cancellation.name = "MCPOAuthCancelledError";
			f.oauth.reject(cancellation);
			await Bun.sleep(0);
			expect(title(f.wizard)).toBe("Sign-in cancelled");
			const retry = Promise.withResolvers<MCPAddWizardOAuthResult>();
			f.onOAuth.mockImplementation(() => retry.promise);
			act(f.wizard, "next");
			expect(f.onOAuth).toHaveBeenCalledTimes(2);
			const second = f.onOAuth.mock.calls[1]?.[5]?.abortSignal;
			expect(second?.aborted).toBe(false);
			expect(second).not.toBe(first);
			expect(f.onCancel).not.toHaveBeenCalled();
			act(f.wizard, "cancel");
			retry.reject(cancellation);
			await Bun.sleep(0);
		});
	}

	it("Back from pending connection lets a newer test proceed while ignoring the older auth error", async () => {
		const f = fixture();
		act(f.wizard, "back");
		expect(title(f.wizard)).toBe("How does omp reach it?");
		const newer = Promise.withResolvers<void>();
		f.onTest.mockImplementation(() => newer.promise);
		// Back retains the URL, so submit the next remote step without typing it again.
		f.wizard.handleNativeEvent({ type: "select", key: "sheet/choices-transport", item: "1" });
		act(f.wizard, "next");
		f.connection.reject(new Error("Old unauthorized result"));
		await Bun.sleep(0);
		expect(f.onOAuth).not.toHaveBeenCalled();
		expect(title(f.wizard)).toBe("Trying the connection");
		newer.resolve();
		await Bun.sleep(1100);
		expect(title(f.wizard)).toBe("Where should it live?");
	});
});
