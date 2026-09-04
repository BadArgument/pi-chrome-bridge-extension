import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BrowserBridgeRuntime } from "./runtime";
import { registerBrowserTools } from "./tools";

const BBRIDGE_SUBCOMMANDS = ["status", "restart", "stop"] as const;

function notifyContext(ctx: ExtensionContext, message: string, level: "info" | "warn" | "error" = "info"): void {
  if (typeof (ctx as ExtensionContext & { notify?: (text: string, tone?: "info" | "warn" | "error") => void }).notify === "function") {
    (ctx as ExtensionContext & { notify: (text: string, tone?: "info" | "warn" | "error") => void }).notify(message, level);
    return;
  }
  ctx.ui.notify(message, level);
}

function getStatusNotification(status: ReturnType<BrowserBridgeRuntime["getStatus"]>): {
  level: "info" | "warn" | "error";
  message: string;
} {
  const level = status.running ? "info" : status.startupIssue ? "warn" : "info";
  const message = status.running
    ? status.role === "follower"
      ? "browser bridge following leader"
      : "browser bridge ready"
    : status.startupIssue
      ? "browser bridge unavailable"
      : "browser bridge stopped";
  return { level, message };
}

function bbridgeUsage(): string {
  return ["Usage:", "/bbridge status|restart|stop"].join("\n");
}

export default function registerBrowserBridge(pi: ExtensionAPI): void {
  const runtime = new BrowserBridgeRuntime();
  void runtime.ensureStarted().catch((error) => {
    console.error("failed to start browser bridge", error);
  });

  pi.on("session_start", async (_event: unknown, _ctx: ExtensionContext) => {
    await runtime.ensureStarted();
  });

  pi.on("session_shutdown", async (_event: unknown, _ctx: ExtensionContext) => {
    await runtime.stop();
  });

  pi.registerCommand("bbridge", {
    description: "Manage browser bridge: status, restart, or stop",
    getArgumentCompletions: async (prefix: string) => {
      const trimmedStart = prefix.trimStart();
      if (trimmedStart.includes(" ")) {
        return null;
      }
      return BBRIDGE_SUBCOMMANDS.filter((item) => item.startsWith(trimmedStart)).map((item) => ({ value: item, label: item }));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const subcommand = args.trim().split(/\s+/, 1)[0] ?? "";
      if (!subcommand) {
        notifyContext(ctx, bbridgeUsage(), "info");
        return;
      }

      switch (subcommand) {
        case "status": {
          const status = runtime.getStatus();
          const notification = getStatusNotification(status);
          notifyContext(ctx, `${notification.message}\n${JSON.stringify(status, null, 2)}`, notification.level);
          return;
        }
        case "restart": {
          await runtime.restart();
          const status = runtime.getStatus();
          const notification = getStatusNotification(status);
          const message = status.running
            ? status.role === "follower"
              ? "browser bridge connected to existing leader"
              : "browser bridge restarted"
            : status.startupIssue
              ? "browser bridge unavailable"
              : "browser bridge stopped";
          notifyContext(ctx, `${message}\n${JSON.stringify(status, null, 2)}`, notification.level);
          return;
        }
        case "stop": {
          await runtime.stop();
          const status = runtime.getStatus();
          notifyContext(ctx, `browser bridge stopped\n${JSON.stringify(status, null, 2)}`, "info");
          return;
        }
        default:
          notifyContext(ctx, bbridgeUsage(), "info");
      }
    },
  });

  registerBrowserTools(pi, runtime);
}
