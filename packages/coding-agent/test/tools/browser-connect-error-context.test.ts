import { afterEach, expect, spyOn, test } from "bun:test";
import puppeteer from "puppeteer-core";
import { connectPuppeteer } from "../../src/tools/browser/launch";
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected a rejected connection");
}
let socketSpy: { mockRestore(): void } | undefined;
afterEach(() => {
	socketSpy?.mockRestore();
	socketSpy = undefined;
});
for (const mode of ["browserURL", "browserWSEndpoint"] as const) {
	test(`refused CDP ${mode} retains endpoint and status`, async () => {
		const cdp = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, server) =>
				new URL(request.url).pathname === "/json/version"
					? Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/gone` })
					: new Response("gone", { status: 404 }),
		});
		const endpoint = `ws://127.0.0.1:${cdp.port}/devtools/browser/gone`;
		try {
			const error = await rejectionOf(
				connectPuppeteer(
					puppeteer,
					mode === "browserURL" ? { browserURL: `http://127.0.0.1:${cdp.port}` } : { browserWSEndpoint: endpoint },
				),
			);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("404");
			expect(error.message).toContain(`WebSocket connection to '${endpoint}'`);
		} finally {
			cdp.stop(true);
		}
	});
}
for (const browserURL of [
	"https://127.0.0.1:9222",
	"http://example.invalid:9222",
	"http://localhost:9222",
	"http://127.0.0.1.example.invalid:9222",
	"http://user:secret@127.0.0.1:9222",
]) {
	test(`does not add raw diagnostics for ${browserURL}`, async () => {
		socketSpy = spyOn(Bun, "connect").mockImplementation(() =>
			Promise.reject(new Error("unexpected raw diagnostic")),
		);
		const cause = new Error("Unexpected server response: 404");
		const transport = {
			connect: async () => {
				throw cause;
			},
		} as unknown as typeof puppeteer;
		const error = await rejectionOf(connectPuppeteer(transport, { browserURL }));
		expect(error.cause).toBe(cause);
		expect(error.message).toContain(browserURL);
		expect(socketSpy).not.toHaveBeenCalled();
	});
}
test("bounds local diagnostic response before parsing its advertised endpoint", async () => {
	const cdp = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			Response.json({
				padding: "x".repeat(128 * 1024),
				webSocketDebuggerUrl: "ws://127.0.0.1/should-not-be-reported",
			}),
	});
	const browserURL = `http://127.0.0.1:${cdp.port}`;
	const cause = new Error("Unexpected server response: 404");
	const transport = {
		connect: async () => {
			throw cause;
		},
	} as unknown as typeof puppeteer;
	try {
		const error = await rejectionOf(connectPuppeteer(transport, { browserURL }));
		expect(error.cause).toBe(cause);
		expect(error.message).toContain(browserURL);
		expect(error.message).not.toContain("should-not-be-reported");
	} finally {
		cdp.stop(true);
	}
});
