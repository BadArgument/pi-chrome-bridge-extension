import type {
  BrowserCaptureInput,
  BrowserFilterInput,
  BrowserNavigateInput,
  BrowserToolName,
} from "../shared/browser-types";
import { captureFilteredHtml, captureVisibleHtml } from "./capture";
import { runNavigate } from "./navigate";
import { getSnapshot } from "./snapshot";

declare global {
  interface Window {
    __PI_BROWSER_CONTENT_INITIALIZED__?: boolean;
  }
}

interface ExecutorMessage {
  type: "pi-browser:tool";
  tool: BrowserToolName;
  args: Record<string, unknown>;
}

function normalizeError(error: unknown) {
  return {
    code: "INVALID_REQUEST",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function execute(tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "browser_capture":
      return captureVisibleHtml((args as unknown as BrowserCaptureInput).maxNodes);
    case "browser_filter":
      return captureFilteredHtml(args as unknown as BrowserFilterInput);
    case "browser_snapshot":
      return getSnapshot();
    case "browser_act":
      throw new Error("browser_act is service-worker main-world only");
    case "browser_script":
      throw new Error("browser_script is service-worker only");
    case "browser_fetch":
      throw new Error("browser_fetch is service-worker only");
    case "browser_navigate":
      return runNavigate(args as unknown as BrowserNavigateInput);
    case "browser_tabs":
      throw new Error("browser_tabs is service-worker only");
    default:
      throw new Error(`Unsupported tool: ${tool}`);
  }
}

function notifyReady(): void {
  try {
    void chrome.runtime.sendMessage({ type: "pi-browser:executor-ready" });
  } catch {
    // ignore
  }
}

function bootstrap(): void {
  if (window.__PI_BROWSER_CONTENT_INITIALIZED__) {
    notifyReady();
    return;
  }
  window.__PI_BROWSER_CONTENT_INITIALIZED__ = true;

  chrome.runtime.onMessage.addListener((message: ExecutorMessage, _sender, sendResponse) => {
    if (!message || message.type !== "pi-browser:tool") {
      return false;
    }

    void execute(message.tool, message.args)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  });

  window.addEventListener("pageshow", notifyReady);
  window.addEventListener("popstate", notifyReady);
  notifyReady();
}

bootstrap();
