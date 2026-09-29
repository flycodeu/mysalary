import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("../src/platform/updates", () => ({ checkForUpdates: mocks.check }));

beforeEach(() => { vi.resetModules(); mocks.check.mockReset(); });

describe("settings update status", () => {
  it("shares an in-flight request and the confirmed version between both views", async () => {
    let finish!: (value: unknown) => void;
    mocks.check.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { useUpdateCheck } = await import("../src/composables/useUpdateCheck");
    const settings = useUpdateCheck(), panel = useUpdateCheck();
    const one = settings.check(), two = panel.check();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(settings.checking.value).toBe(true);
    finish({ state: "available", version: "2.0.0", download: true, url: "https://github.com/flycodeu/mysalary/releases/tag/v2.0.0", notes: "" });
    await Promise.all([one, two]);
    expect(settings.available.value).toBe(true);
    expect(settings.label.value).toBe("有新版本 2.0.0");
    expect(panel.result.value).toEqual(settings.result.value);
  });

  it("removes an old release offer after network failure and recovers on retry", async () => {
    const { useUpdateCheck } = await import("../src/composables/useUpdateCheck");
    const state = useUpdateCheck();
    mocks.check.mockResolvedValueOnce({ state: "available", version: "2.0.0", download: true, url: "", notes: "" });
    await state.check();
    mocks.check.mockRejectedValueOnce(new Error("网络连接失败"));
    await state.check();
    expect(state.available.value).toBe(false);
    expect(state.result.value).toBeUndefined();
    expect(state.label.value).toBe("检查失败，点击重试");
    mocks.check.mockResolvedValueOnce({ state: "current" });
    await state.check();
    expect(state.error.value).toBe("");
    expect(state.label.value).toBe("已是最新版本");
  });

  it("does not check automatically during startup", async () => {
    const { useUpdateCheck } = await import("../src/composables/useUpdateCheck");
    const state = useUpdateCheck();
    expect(state.checking.value).toBe(false);
    expect(state.label.value).toBe("检查更新");
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
