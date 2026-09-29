import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ native: false, hostCall: vi.fn() }));
vi.mock("../src/platform/host", () => ({
  get isNative() { return state.native; }, hostCall: state.hostCall,
}));

let values: Map<string, string>;
beforeEach(() => {
  state.native = false;
  state.hostCall.mockReset();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("app settings persistence", () => {
  it("keeps confirmation on when preferences are missing or malformed", async () => {
    const { loadAppSettings } = await import("../src/platform/settings");
    for (const saved of [undefined, "not-json", "null", '{"confirmExit":"false"}']) {
      values.clear();
      if (saved !== undefined) values.set("salary-app-settings", saved);
      expect(await loadAppSettings()).toEqual({ confirmExit: true });
    }
  });

  it("restores a disabled preference without touching salary storage", async () => {
    const { loadAppSettings, saveAppSettings } = await import("../src/platform/settings");
    values.set("salary-ledger", "synthetic-ledger");
    await saveAppSettings({ confirmExit: false });
    expect(await loadAppSettings()).toEqual({ confirmExit: false });
    expect(values.get("salary-ledger")).toBe("synthetic-ledger");
  });

  it("uses native persistence and does not silently fall back after a native failure", async () => {
    const { loadAppSettings, saveAppSettings } = await import("../src/platform/settings");
    state.native = true;
    state.hostCall.mockResolvedValueOnce({ confirmExit: false });
    expect(await loadAppSettings()).toEqual({ confirmExit: false });
    expect(state.hostCall).toHaveBeenCalledWith("getAppSettings");
    state.hostCall.mockRejectedValueOnce(new Error("disk failure"));
    await expect(saveAppSettings({ confirmExit: true })).rejects.toThrow("disk failure");
    expect(values.size).toBe(0);
  });
});
