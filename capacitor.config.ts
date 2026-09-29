import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.flylabs.salary",
  appName: "薪迹",
  webDir: "dist",
  loggingBehavior: "none",
  android: { webContentsDebuggingEnabled: false },
};

export default config;
