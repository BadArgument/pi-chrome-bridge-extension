import type {
  BrowserActInput,
  BrowserFetchInput,
  BrowserFetchResult,
  BrowserNavigateInput,
  BrowserScriptInput,
  BrowserScriptResult,
  BrowserTabsInput,
  BrowserTabsResult,
  BrowserToolName,
} from "../shared/browser-types";
import { TOOL_TIMEOUT_MS } from "../shared/limits";
import { createBridgeError, createMessage, type BridgeErrorPayload, type BridgeMessage } from "../shared/protocol";
import type { TabRegistry } from "./tab-registry";

interface ExecutorResponse {
  ok: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

export async function ensureExecutor(tabId: number, registry: TabRegistry): Promise<void> {
  const tab = registry.get(tabId);
  if (!tab) {
    throw createBridgeError("TAB_NOT_FOUND", `tab ${tabId} not found`);
  }
  if (!tab.injectable) {
    throw createBridgeError("TAB_NOT_INJECTABLE", `tab ${tabId} not injectable`, { reason: tab.restrictedReason });
  }
  if (tab.executorReady) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  registry.setExecutorReady(tabId, true);
}

async function sendToExecutor(tabId: number, tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "pi-browser:tool",
    tool,
    args,
  })) as ExecutorResponse;

  if (!response?.ok) {
    throw createBridgeError(
      (response?.error?.code as Parameters<typeof createBridgeError>[0]) ?? "INVALID_REQUEST",
      response?.error?.message ?? `${tool} failed`,
    );
  }

  return response.result;
}

async function runScriptInMainWorld(input: BrowserScriptInput): Promise<BrowserScriptResult> {
  const timeoutMs =
    typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
      ? input.timeout
      : TOOL_TIMEOUT_MS.browser_script;

  try {
    const execution = await chrome.scripting.executeScript({
      target: { tabId: Number.parseInt(input.tabID, 10) },
      world: "MAIN",
      func: async (source: string, timeout: number) => {
        try {
          const pageEval = typeof window.eval === "function" ? window.eval.bind(window) : eval;
          const evaluated = pageEval(`(${source})`);
          if (typeof evaluated !== "function") {
            return { ok: false, error: "script must evaluate to a function" };
          }

          const timeoutPromise = new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error(`script timed out after ${timeout}ms`)), timeout);
          });
          const result = await Promise.race([Promise.resolve(evaluated.call(window)), timeoutPromise]);

          if (!result || typeof result !== "object" || Array.isArray(result)) {
            return { ok: false, error: "script must return a JSON-serializable object" };
          }
          const serialized = JSON.stringify(result);
          if (serialized === undefined) {
            return { ok: false, error: "script result is not JSON-serializable" };
          }
          return {
            ok: true,
            result: JSON.parse(serialized) as Record<string, unknown>,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      args: [input.script, timeoutMs],
    });
    return execution[0]?.result ?? { ok: false, error: "empty script result" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function resolveFetchUrl(rawUrl: string, tabUrl?: string): string {
  return new URL(rawUrl, tabUrl).toString();
}

function normalizeFetchCredentials(mode: RequestCredentials | undefined, requestUrl: string, tabUrl?: string): RequestCredentials {
  const normalized = mode ?? "same-origin";
  if (normalized !== "same-origin") {
    return normalized;
  }
  if (!tabUrl) {
    return "omit";
  }

  try {
    const request = new URL(requestUrl);
    const tab = new URL(tabUrl);
    if ((request.protocol === "http:" || request.protocol === "https:") && request.origin === tab.origin) {
      return "include";
    }
  } catch {
    // fall through
  }

  return "omit";
}

async function runFetchInServiceWorker(input: BrowserFetchInput, tabUrl?: string): Promise<BrowserFetchResult> {
  let requestUrl: string;
  try {
    requestUrl = resolveFetchUrl(input.url, tabUrl);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "FETCH_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetch(requestUrl, {
      method: input.body?.method ?? "GET",
      headers: input.body?.headers,
      body: input.body?.payload,
      credentials: normalizeFetchCredentials(input.body?.credentials, requestUrl, tabUrl),
    });

    const headers = headersToObject(response.headers);
    const responseType = input.body?.responseType ?? "text";

    if (responseType === "blob") {
      const buffer = new Uint8Array(await response.arrayBuffer());
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers,
        mimeType: response.headers.get("content-type") ?? undefined,
        size: buffer.byteLength,
        data: toBase64(buffer),
        encoding: "base64",
      };
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      data: await response.text(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "FETCH_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runActInMainWorld(input: BrowserActInput): Promise<unknown> {
  try {
    const execution = await chrome.scripting.executeScript({
      target: { tabId: Number.parseInt(input.tabID, 10) },
      world: "MAIN",
      func: (payload: BrowserActInput) => {
        const failure = (error: string, message?: string) => ({ ok: false, error, message });

        const queryElementInRoot = (root: Document | DocumentFragment | Element, selector: string): Element | null => {
          const children = Array.from(root.children);
          for (const child of children) {
            if (child.matches(selector)) {
              return child;
            }
            if (child.shadowRoot) {
              const inShadow = queryElementInRoot(child.shadowRoot, selector);
              if (inShadow) {
                return inShadow;
              }
            }
            const inLightDom = queryElementInRoot(child, selector);
            if (inLightDom) {
              return inLightDom;
            }
          }
          return null;
        };

        const queryElement = (selector: string) => queryElementInRoot(document, selector);
        const asInteractable = (element: Element) => (element instanceof HTMLElement ? element : null);
        const parseScrollDelta = (value: string | number | undefined, axis: "x" | "y") => {
          if (value === undefined) {
            return 0;
          }
          if (typeof value === "number") {
            return Number.isFinite(value) ? value : Number.NaN;
          }
          const normalized = value.trim().toLowerCase();
          if (!normalized) {
            return 0;
          }
          if (/^-?\d+(\.\d+)?$/.test(normalized)) {
            return Number.parseFloat(normalized);
          }
          const match = normalized.match(/^(-?\d+(?:\.\d+)?)(px|vw|vh|%)$/);
          if (!match) {
            return Number.NaN;
          }
          const amount = Number.parseFloat(match[1]);
          const unit = match[2];
          if (unit === "px") {
            return amount;
          }
          const base = unit === "vw" ? window.innerWidth : unit === "vh" ? window.innerHeight : axis === "x" ? window.innerWidth : window.innerHeight;
          return (amount / 100) * base;
        };
        const getComposedParent = (node: Node | null): Node | null => {
          if (!node) {
            return null;
          }
          if (node.parentNode) {
            return node.parentNode;
          }
          const root = node.getRootNode();
          return root instanceof ShadowRoot ? root.host : null;
        };
        const resolveClickableElement = (element: Element): Element => {
          let current: Node | null = element;
          while (current) {
            if (current instanceof HTMLElement && typeof current.click === "function") {
              return current;
            }
            current = getComposedParent(current);
          }
          return element;
        };
        const dispatchKeyboardEvent = (element: Element, type: "keydown" | "keyup" | "keypress", keys: string[]) => {
          for (const key of keys) {
            element.dispatchEvent(
              new KeyboardEvent(type, {
                key,
                bubbles: true,
                cancelable: true,
                composed: true,
              }),
            );
          }
        };
        const setNativeValue = (target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
          const prototype =
            target instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : target instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLSelectElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          descriptor?.set?.call(target, value);
        };
        const runInput = (element: Element, value: string | undefined) => {
          const target = asInteractable(element);
          if (!target || !("value" in target)) {
            return failure("ELEMENT_NOT_INTERACTABLE");
          }
          const inputTarget = target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          setNativeValue(inputTarget, value ?? "");
          target.dispatchEvent(
            new InputEvent("input", { bubbles: true, cancelable: true, composed: true, data: value ?? "" }),
          );
          return { ok: true, message: "input dispatched in main world" };
        };
        const runScroll = () => {
          const top = parseScrollDelta(payload.scrollDeltaY, "y");
          const left = parseScrollDelta(payload.scrollDeltaX, "x");
          if (Number.isNaN(top) || Number.isNaN(left)) {
            return failure("INVALID_REQUEST", "invalid scroll delta");
          }
          window.scrollBy({ top, left, behavior: "instant" });
          return { ok: true, message: `window scrolled by x=${left}, y=${top}` };
        };
        const runDrag = (source: Element) => {
          if (!payload.targetSelector) {
            return failure("DRAG_TARGET_NOT_FOUND", "targetSelector required for drag");
          }
          const target = queryElement(payload.targetSelector);
          if (!target) {
            return failure("DRAG_TARGET_NOT_FOUND");
          }
          const dataTransfer = typeof DataTransfer === "function" ? new DataTransfer() : undefined;
          source.dispatchEvent(
            new DragEvent("dragstart", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer,
            }),
          );
          target.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer,
            }),
          );
          source.dispatchEvent(
            new DragEvent("dragend", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer,
            }),
          );
          return { ok: true, message: "drag dispatched in main world" };
        };

        try {
          if (payload.action === "scroll") {
            return runScroll();
          }

          if (!payload.selector) {
            return failure("ELEMENT_NOT_FOUND", "selector required");
          }

          const element = queryElement(payload.selector);
          if (!element) {
            return failure("ELEMENT_NOT_FOUND");
          }

          switch (payload.action) {
            case "click": {
              const target = resolveClickableElement(element);
              if (!(target instanceof HTMLElement) || typeof target.click !== "function") {
                return failure("ELEMENT_NOT_INTERACTABLE");
              }
              target.click();
              return { ok: true, message: "native click applied in main world" };
            }
            case "focus": {
              const target = asInteractable(element);
              if (!target) {
                return failure("ELEMENT_NOT_INTERACTABLE");
              }
              target.focus();
              return { ok: true, message: "focused in main world" };
            }
            case "input":
              return runInput(element, payload.value);
            case "keydown":
            case "keyup":
            case "keypress":
              dispatchKeyboardEvent(element, payload.action, payload.keys ?? []);
              return { ok: true, message: `${payload.action} dispatched in main world` };
            case "drag":
              return runDrag(element);
          }
        } catch (error) {
          return failure("ACT_DISPATCH_FAILED", error instanceof Error ? error.message : String(error));
        }
      },
      args: [input],
    });

    return execution[0]?.result ?? { ok: false, error: "ACT_DISPATCH_FAILED", message: "empty main-world result" };
  } catch (error) {
    throw createBridgeError("ACT_DISPATCH_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function parseTabID(tabID: string | undefined): number {
  const parsed = Number.parseInt(tabID ?? "", 10);
  if (Number.isNaN(parsed)) {
    throw createBridgeError("TAB_NOT_FOUND", "invalid or missing tabID");
  }
  return parsed;
}

async function runBrowserTabs(input: BrowserTabsInput | undefined, registry: TabRegistry): Promise<BrowserTabsResult> {
  const action = input?.action ?? "list";

  switch (action) {
    case "list": {
      await registry.refreshAllTabs();
      return registry.list();
    }
    case "create": {
      const created = await chrome.tabs.create(input?.url ? { url: input.url } : {});
      if (created.id !== undefined) {
        registry.upsert(created);
        registry.markActive(created.id);
      }
      return {
        ok: true,
        action,
        tabID: created.id !== undefined ? String(created.id) : undefined,
      };
    }
    case "delete": {
      const tabId = parseTabID(input?.tabID);
      await chrome.tabs.remove(tabId);
      registry.remove(tabId);
      return {
        ok: true,
        action,
        tabID: String(tabId),
      };
    }
    case "activate": {
      const tabId = parseTabID(input?.tabID);
      const activated = await chrome.tabs.update(tabId, { active: true });
      if (!activated) {
        throw createBridgeError("TAB_NOT_FOUND", `tab ${tabId} not found`);
      }
      registry.upsert(activated);
      registry.markActive(tabId);
      return {
        ok: true,
        action,
        tabID: String(tabId),
      };
    }
  }
}

async function runNavigate(input: BrowserNavigateInput, registry: TabRegistry): Promise<{ ok: boolean }> {
  const tabId = Number.parseInt(input.tabID, 10);
  switch (input.action) {
    case "goto": {
      if (!input.url) {
        throw createBridgeError("NAVIGATION_FAILED", "goto requires url");
      }
      await chrome.tabs.update(tabId, { url: input.url });
      registry.setExecutorReady(tabId, false);
      return { ok: true };
    }
    case "reload": {
      await chrome.tabs.reload(tabId);
      registry.setExecutorReady(tabId, false);
      return { ok: true };
    }
    case "back":
    case "forward": {
      await ensureExecutor(tabId, registry);
      return (await sendToExecutor(tabId, "browser_navigate", input as unknown as Record<string, unknown>)) as { ok: boolean };
    }
  }
}

export async function routeBridgeRequest(message: BridgeMessage, registry: TabRegistry): Promise<BridgeMessage> {
  const tool = message.tool;
  if (!tool) {
    return createMessage({
      kind: "response",
      source: "chrome-sw",
      replyTo: message.id,
      error: createBridgeError("INVALID_REQUEST", "missing tool"),
    });
  }

  try {
    if (tool === "browser_tabs") {
      return createMessage({
        kind: "response",
        source: "chrome-sw",
        replyTo: message.id,
        tool,
        payload: await runBrowserTabs(message.payload as BrowserTabsInput | undefined, registry),
      });
    }

    const tabId = message.tabID;
    if (tabId === undefined) {
      throw createBridgeError("TAB_NOT_FOUND", "missing tabID");
    }

    const tab = registry.get(tabId);
    if (!tab) {
      throw createBridgeError("TAB_NOT_FOUND", `tab ${tabId} not found`);
    }
    if (!tab.injectable && tool !== "browser_navigate" && tool !== "browser_fetch") {
      throw createBridgeError("TAB_NOT_INJECTABLE", `tab ${tabId} not injectable`, { reason: tab.restrictedReason });
    }

    if (tool === "browser_script") {
      return createMessage({
        kind: "response",
        source: "chrome-sw",
        replyTo: message.id,
        tool,
        tabID: tabId,
        payload: await runScriptInMainWorld(message.payload as BrowserScriptInput),
      });
    }

    if (tool === "browser_fetch") {
      const currentTab = await chrome.tabs.get(tabId);
      registry.upsert(currentTab);
      return createMessage({
        kind: "response",
        source: "chrome-sw",
        replyTo: message.id,
        tool,
        tabID: tabId,
        payload: await runFetchInServiceWorker(message.payload as BrowserFetchInput, currentTab.url ?? tab.url),
      });
    }

    if (tool === "browser_act") {
      return createMessage({
        kind: "response",
        source: "chrome-sw",
        replyTo: message.id,
        tool,
        tabID: tabId,
        payload: await runActInMainWorld(message.payload as BrowserActInput),
      });
    }

    if (tool === "browser_navigate") {
      return createMessage({
        kind: "response",
        source: "chrome-sw",
        replyTo: message.id,
        tool,
        tabID: tabId,
        payload: await runNavigate(message.payload as BrowserNavigateInput, registry),
      });
    }

    await ensureExecutor(tabId, registry);

    return createMessage({
      kind: "response",
      source: "chrome-sw",
      replyTo: message.id,
      tool,
      tabID: tabId,
      payload: await sendToExecutor(tabId, tool, message.payload as Record<string, unknown>),
    });
  } catch (error) {
    const bridgeError: BridgeErrorPayload =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string"
        ? (error as BridgeErrorPayload)
        : createBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));

    return createMessage({
      kind: "response",
      source: "chrome-sw",
      replyTo: message.id,
      tool,
      tabID: message.tabID,
      error: bridgeError,
    });
  }
}
