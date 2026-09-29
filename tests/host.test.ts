import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web" },
  registerPlugin: () => ({}),
}));

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Windows document storage connection", () => {
  it("keeps a desktop document native when its bridge has not arrived", async () => {
    const win: { __salaryDesktop: boolean; chrome?: unknown } = { __salaryDesktop: true };
    vi.stubGlobal("window", win);
    const host = await import("../src/platform/host");
    expect(host.isWindows).toBe(true);
    expect(host.isNative).toBe(true);
    await expect(host.hostCall("loadLedger")).rejects.toThrow("尚未就绪");

    let listener: (event: { data: unknown }) => void;
    win.chrome = { webview: {
      addEventListener: (_type: string, receive: typeof listener) => { listener = receive; },
      postMessage: ({ id }: { id: string }) => listener({ data: { id, result: { content: "saved" } } }),
    } };
    await expect(host.hostCall("loadLedger")).resolves.toEqual({ content: "saved" });
  });

  it("reports bridge send failures immediately and clears the pending timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { __salaryDesktop: true, chrome: { webview: {
      addEventListener: vi.fn(),
      postMessage: () => { throw new Error("channel closed"); },
    } } });
    const { hostCall } = await import("../src/platform/host");
    await expect(hostCall("saveLedger", { content: "test" })).rejects.toThrow("连接失败");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat a normal browser as the desktop program", async () => {
    vi.stubGlobal("window", {});
    const { isWindows, isNative, hostCall } = await import("../src/platform/host");
    expect(isWindows).toBe(false);
    expect(isNative).toBe(false);
    await expect(hostCall("loadLedger")).rejects.toThrow("Windows 或 Android 应用");
  });

  it("forwards a desktop close request separately from bridge responses", async () => {
    const dispatchEvent = vi.fn();
    let listener: (event: { data: unknown }) => void;
    vi.stubGlobal("window", { __salaryDesktop: true, dispatchEvent, chrome: { webview: {
      addEventListener: (_type: string, receive: typeof listener) => { listener = receive; },
      postMessage: ({ id }: { id: string }) => {
        listener({ data: { event: "requestExit" } });
        listener({ data: { id, result: {} } });
      },
    } } });
    const { hostCall } = await import("../src/platform/host");
    await expect(hostCall("setExitHandlerReady", { ready: true })).resolves.toEqual({});
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe("salary:request-exit");
  });
});
