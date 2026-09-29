export const RELEASES_URL = "https://github.com/flycodeu/mysalary/releases";
export const RELEASE_API = "https://api.github.com/repos/flycodeu/mysalary/releases/latest";
export type UpdatePlatform = "windows" | "android" | "web";
export type UpdateResult =
  | { state: "unpublished" | "current" }
  | { state: "available"; version: string; url: string; download: boolean; notes: string };

function versionParts(version: string): number[] {
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) throw new Error("发行版本号无效");
  return version.split(".").map(Number);
}

export function newerVersion(candidate: string, installed: string): boolean {
  const next = versionParts(candidate);
  const current = versionParts(installed);
  for (let index = 0; index < 3; index++) {
    if (next[index] !== current[index]) return next[index]! > current[index]!;
  }
  return false;
}

// Only a release in this repository can become a download action. Metadata is untrusted.
export function parseRelease(
  status: number,
  content: string | null,
  installed: string,
  platform: UpdatePlatform,
): UpdateResult {
  if (status === 404) return { state: "unpublished" };
  if (status === 403 || status === 429) throw new Error("检查次数过多，请稍后重试");
  if (status !== 200) throw new Error("暂时无法连接更新服务，请稍后重试");
  let value;
  try { value = JSON.parse(content ?? ""); }
  catch { throw new Error("更新信息无法读取，请稍后重试"); }
  if (!value || value.draft !== false || value.prerelease !== false ||
      typeof value.tag_name !== "string" || !/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.tag_name)) {
    throw new Error("更新信息不是有效的正式发行版");
  }
  const version = value.tag_name.slice(1);
  if (!newerVersion(version, installed)) return { state: "current" };
  const suffix = platform === "windows" ? "windows-setup.exe" : "debug.apk";
  const assetName = `salary-${version}-${suffix}`;
  const downloadUrl = `${RELEASES_URL}/download/${value.tag_name}/${assetName}`;
  const download = platform !== "web" && Array.isArray(value.assets) && value.assets.some(
    (asset: unknown) => {
      if (!asset || typeof asset !== "object") return false;
      const file = asset as Record<string, unknown>;
      return file.name === assetName && file.browser_download_url === downloadUrl &&
        file.state === "uploaded" && typeof file.size === "number" && file.size > 0;
    },
  );
  return {
    state: "available", version, download,
    url: download ? downloadUrl : `${RELEASES_URL}/tag/${value.tag_name}`,
    notes: typeof value.body === "string" ? value.body.slice(0, 4000).trim() : "",
  };
}
