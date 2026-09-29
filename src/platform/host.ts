import { Capacitor, registerPlugin } from "@capacitor/core";

interface DesktopMessage {
  id: string;
  result?: unknown;
  error?: string;
}
interface DesktopWebView {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: DesktopMessage }) => void,
  ): void;
}
declare global {
  interface Window {
    __salaryDesktop?: boolean;
    chrome?: { webview?: DesktopWebView };
  }
}
// The host marks its document before loading Vue, even if the message bridge is not ready yet.
export const isWindows = window.__salaryDesktop === true || Boolean(window.chrome?.webview);
export const isNative = isWindows || Capacitor.getPlatform() === "android";
const native =
  registerPlugin<
    Record<string, (args: Record<string, unknown>) => Promise<unknown>>
  >("SalaryNative");
const requests = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function receiveDesktopMessage({ data }: { data: DesktopMessage }) {
  if (!data || typeof data.id !== "string") return;
  const request = requests.get(data.id);
  if (!request) return;
  requests.delete(data.id);
  clearTimeout(request.timer);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.result);
}
let connectedView: DesktopWebView | undefined;
function desktopBridge(): DesktopWebView | undefined {
  const view = window.chrome?.webview;
  if (view && connectedView !== view) {
    view.addEventListener("message", receiveDesktopMessage);
    connectedView = view;
  }
  return view;
}

export function hostCall<T>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (isWindows)
    return new Promise<T>((resolve, reject) => {
      const view = desktopBridge();
      if (!view) {
        reject(new Error("桌面数据连接尚未就绪，请重试读取或重新打开薪迹"));
        return;
      }
      const id = crypto.randomUUID();
      // A file picker can remain open while the user chooses a destination.
      const timer = setTimeout(
        () => {
          requests.delete(id);
          reject(new Error("操作超时，请重试"));
        },
        method.includes("File") ? 600_000 : method === "loadLedger" ? 15_000 : 90_000,
      );
      requests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        view.postMessage({ id, method, args });
      } catch {
        requests.delete(id);
        clearTimeout(timer);
        reject(new Error("桌面数据连接失败，请重新打开薪迹"));
      }
    });
  if (Capacitor.getPlatform() === "android")
    return native[method]!(args) as Promise<T>;
  return Promise.reject(
    new Error("请在薪迹 Windows 或 Android 应用中使用此功能"),
  );
}
