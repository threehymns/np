import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { PluginHost } from "./host.svelte";
import { RawTransactionDispatchError, DirectEditorViewAccessError } from "./errors";

/**
 * AC6: every mismatch yields an AI-fixable error. The proxy must not
 * mislabel forbidden view/dispatch access as generic editor access, and
 * unknown members (typos) must name themselves as unknown with a fix.
 */
describe("plugin host proxy diagnostics", () => {
	async function captureProxy(): Promise<any> {
		const host = new PluginHost();
		let captured: unknown;
		host.register({
			manifest: { id: "probe", name: "Probe", version: 0 },
			setup: (received) => {
				captured = received;
			}
		});
		await host.activate("probe");
		return captured;
	}

	it("routes forbidden dispatch through the dedicated error, not generic view access", async () => {
		const proxy = await captureProxy();
		expect(() => (proxy as any).dispatch({})).toThrow(RawTransactionDispatchError);
		expect(() => (proxy as any).dispatchTransaction({})).toThrow(RawTransactionDispatchError);
	});

	it("routes forbidden view access through the dedicated error", async () => {
		const proxy = await captureProxy();
		expect(() => (proxy as any).view).toThrow(DirectEditorViewAccessError);
		expect(() => (proxy as any).editorView).toThrow(DirectEditorViewAccessError);
		expect(() => (proxy as any).getActiveEditorView()).toThrow(DirectEditorViewAccessError);
	});

	it("names unknown members as unknown with an actionable fix", async () => {
		const proxy = await captureProxy();
		let error: unknown;
		try {
			(proxy as any).saveDocument({});
		} catch (e) {
			error = e;
		}
		expect(error).toBeDefined();
		expect((error as Error).name).toBe("UnknownPluginHostMethodError");
		expect((error as Error).message).toContain("saveDocument");
		expect((error as Error).message).toContain("Action:");
		expect(error).not.toBeInstanceOf(DirectEditorViewAccessError);
	});
});
