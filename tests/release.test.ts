import { describe, expect, it } from "vitest";
import { newerVersion, parseRelease, RELEASES_URL } from "../src/domain/release";

function release(overrides = {}) {
  return JSON.stringify({
    tag_name: "v0.5.0", draft: false, prerelease: false,
    body: "月度汇总改进", assets: ["windows-setup.exe", "debug.apk"].map((suffix) => ({
      name: `salary-0.5.0-${suffix}`, state: "uploaded", size: 100,
      browser_download_url: `${RELEASES_URL}/download/v0.5.0/salary-0.5.0-${suffix}`,
    })), ...overrides,
  });
}

describe("release updates", () => {
  it("compares numeric versions and never offers a downgrade", () => {
    expect(newerVersion("0.10.0", "0.9.3")).toBe(true);
    expect(newerVersion("1.0.0", "0.99.99")).toBe(true);
    for (const version of ["0.4.0", "0.3.9"]) expect(newerVersion(version, "0.4.0")).toBe(false);
    expect(() => newerVersion("0.5.0-rc1", "0.4.0")).toThrow();
  });
  it("handles unpublished, current, limits and network errors separately", () => {
    expect(parseRelease(404, null, "0.4.0", "windows")).toEqual({ state: "unpublished" });
    expect(parseRelease(200, release(), "0.5.0", "windows")).toEqual({ state: "current" });
    expect(() => parseRelease(403, null, "0.4.0", "windows")).toThrow("次数过多");
    expect(() => parseRelease(503, null, "0.4.0", "windows")).toThrow("无法连接");
  });
  it.each(["windows", "android"] as const)("selects the matching %s installer", (platform) => {
    expect(parseRelease(200, release(), "0.4.0", platform)).toMatchObject({
      state: "available", download: true,
      url: `${RELEASES_URL}/download/v0.5.0/salary-0.5.0-${platform === "windows" ? "windows-setup.exe" : "debug.apk"}`,
    });
  });
  it("requires the same repository, version, asset identity and completed upload", () => {
    for (const changed of [
      { browser_download_url: "https://attacker.example/setup.exe" },
      { browser_download_url: `${RELEASES_URL}/download/v0.4.0/salary-0.5.0-windows-setup.exe` },
      { browser_download_url: `${RELEASES_URL}/download/v0.5.0/salary-0.5.0-windows-setup.exe?redirect=evil` },
      { state: "new" }, { size: 0 }, { name: "unrelated.exe" },
    ]) {
      const original = JSON.parse(release());
      original.assets[0] = { ...original.assets[0], ...changed };
      expect(parseRelease(200, JSON.stringify(original), "0.4.0", "windows"))
        .toMatchObject({ state: "available", download: false, url: `${RELEASES_URL}/tag/v0.5.0` });
    }
  });
  it("does not substitute an Android release signing channel for the existing debug channel", () => {
    expect(parseRelease(200, release({ assets: [{ name: "salary-0.5.0-release.apk" }] }), "0.4.0", "android"))
      .toMatchObject({ download: false });
  });
  it("shows a release page for web preview and missing platform packages", () => {
    expect(parseRelease(200, release(), "0.4.0", "web")).toMatchObject({ download: false });
    expect(parseRelease(200, release({ assets: [] }), "0.4.0", "windows")).toMatchObject({ download: false });
  });
  it("rejects malformed, draft and prerelease responses", () => {
    for (const content of ["<html>", "null", "{}", release({ draft: true }), release({ prerelease: true }), release({ tag_name: "latest" })]) {
      expect(() => parseRelease(200, content, "0.4.0", "windows")).toThrow();
    }
  });
});
