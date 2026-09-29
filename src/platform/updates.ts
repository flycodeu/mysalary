import { version } from "../../package.json";
import { parseRelease, RELEASE_API, RELEASES_URL } from "../domain/release";
import { hostCall, isAndroid, isNative, isWindows } from "./host";

export const appVersion = version;

export type DownloadUpdateStatus = {
  state: "idle" | "downloading" | "verifying" | "ready" | "error";
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
};

export function getUpdateDownloadStatus(): Promise<DownloadUpdateStatus> {
  if (!isAndroid) return Promise.resolve({ state: "idle" });
  return hostCall<DownloadUpdateStatus>("getUpdateDownloadStatus");
}

export function downloadUpdate(version: string): Promise<DownloadUpdateStatus> {
  if (!isAndroid) return Promise.reject(new Error("当前平台不支持应用内安装"));
  return hostCall<DownloadUpdateStatus>("downloadUpdate", { version });
}

export async function cancelUpdateDownload(): Promise<void> {
  if (isAndroid) await hostCall("cancelUpdateDownload");
}

export function installUpdate(version: string): Promise<{ state: "installer-opened" | "permission-required" }> {
  if (!isAndroid) return Promise.reject(new Error("当前平台不支持应用内安装"));
  return hostCall("installUpdate", { version });
}

export async function checkForUpdates() {
  let response: { status: number; content: string | null };
  if (isNative) response = await hostCall("checkForUpdates");
  else {
    try {
      const result = await fetch(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json" },
        credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      const content = await result.text();
      if (content.length > 512_000) throw new Error("Response too large");
      response = { status: result.status, content };
    } catch { throw new Error("暂时无法连接更新服务，请检查网络后重试"); }
  }
  return parseRelease(response.status, response.content, appVersion,
    isWindows ? "windows" : isNative ? "android" : "web");
}

export async function openRelease(url: string) {
  if (url !== RELEASES_URL && !new RegExp(
    `^${RELEASES_URL.replaceAll(".", "\\.")}/(?:tag/v\\d+\\.\\d+\\.\\d+|download/v\\d+\\.\\d+\\.\\d+/salary-\\d+\\.\\d+\\.\\d+-(?:windows-setup\\.exe|debug\\.apk))$`,
  ).test(url)) throw new Error("更新地址无效");
  if (isNative) await hostCall("openExternal", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

