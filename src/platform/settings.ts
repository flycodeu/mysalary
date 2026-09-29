import { hostCall, isNative } from "./host";

export interface AppSettings {
  confirmExit: boolean;
}

export const defaultAppSettings = (): AppSettings => ({ confirmExit: true });
const settingsKey = "salary-app-settings";

function normalizeSettings(value: unknown): AppSettings {
  return {
    confirmExit: typeof value === "object" && value !== null &&
      "confirmExit" in value && typeof value.confirmExit === "boolean"
      ? value.confirmExit : true,
  };
}

export async function loadAppSettings(): Promise<AppSettings> {
  if (isNative) return normalizeSettings(await hostCall("getAppSettings"));
  const saved = localStorage.getItem(settingsKey);
  if (!saved) return defaultAppSettings();
  try { return normalizeSettings(JSON.parse(saved)); }
  catch { return defaultAppSettings(); }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  if (typeof settings.confirmExit !== "boolean") throw new Error("设置内容无效");
  if (isNative) await hostCall("setAppSettings", { confirmExit: settings.confirmExit });
  else localStorage.setItem(settingsKey, JSON.stringify(settings));
}
