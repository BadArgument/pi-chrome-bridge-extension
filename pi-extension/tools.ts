import type { ExtensionAPI, ExtensionToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  BrowserActInput,
  BrowserCaptureInput,
  BrowserFetchInput,
  BrowserFilterInput,
  BrowserNavigateInput,
  BrowserScriptInput,
  BrowserSnapshotInput,
  BrowserTabsInput,
  BrowserToolName,
  TabInfo,
} from "./shared/browser-types";
import { attachToolRenderMeta, buildBrowserCallLine, buildToolResultView, renderToolResult, type BrowserToolRenderMeta } from "./render";
import { TOOL_TIMEOUT_MS } from "./shared/limits";

const tabsSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "create", "delete", "activate"],
      description:
        'Tab action. "list" returns all known tabs; "create" opens a new tab; "delete" closes the tab in tabID; "activate" makes the tab active without focusing its browser window. Omit to use "list".',
    },
    tabID: {
      type: "string",
      description: 'Target Chrome tab ID as a string. Required for "delete" and "activate"; ignored by "list"; optional for "create".',
    },
    url: {
      type: "string",
      description: 'Initial URL for "create". Optional for "create"; ignored by "list", "delete", and "activate".',
    },
  },
  allOf: [
    {
      if: {
        properties: { action: { enum: ["delete", "activate"] } },
        required: ["action"],
      },
      then: {
        required: ["tabID"],
      },
    },
  ],
  additionalProperties: false,
};

const captureSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID whose currently visible page structure will be captured." },
    maxNodes: {
      type: "number",
      minimum: 1,
      description: "Maximum number of DOM nodes to serialize, including nodes inside open shadow roots. Must be >= 1.",
    },
  },
  required: ["tabID"],
  additionalProperties: false,
};

const snapshotSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID whose full HTML snapshot will be read." },
  },
  required: ["tabID"],
  additionalProperties: false,
};

const filterSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID whose page will be searched and captured." },
    selector: {
      type: "string",
      description:
        "CSS selector matched across light DOM and open shadow roots. Matching elements are grouped into a deduplicated minimal HTML forest.",
    },
    maxNodes: {
      type: "number",
      minimum: 1,
      description: "Maximum number of DOM nodes to serialize into the filtered HTML result, including open shadow-root nodes. Must be >= 1.",
    },
  },
  required: ["tabID", "selector"],
  additionalProperties: false,
};

const actSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID where the DOM action will run in main world." },
    selector: {
      type: "string",
      description:
        'CSS selector for the source element. Required for every action except "scroll". Selector lookup includes light DOM and open shadow roots.',
    },
    action: {
      type: "string",
      enum: ["click", "keydown", "keyup", "keypress", "input", "focus", "scroll", "drag"],
      description:
        'DOM action to run. "click" calls native click(); "keydown"/"keyup"/"keypress" dispatch keyboard events from selector; "input" writes value and dispatches input; "focus" focuses selector; "scroll" scrolls the window by scrollDeltaX/scrollDeltaY; "drag" drags from selector to targetSelector.',
    },
    value: {
      type: "string",
      description: 'Text value used only when action is "input". It becomes the element value before the input event is dispatched.',
    },
    keys: {
      type: "array",
      description: 'Ordered key values used by "keydown", "keyup", or "keypress". Each array item becomes KeyboardEvent.key.',
      items: { type: "string", description: 'One keyboard key value, for example "Enter", "Tab", or "a".' },
    },
    scrollDeltaY: {
      anyOf: [{ type: "number" }, { type: "string" }],
      description:
        'Window-relative vertical scroll delta used only when action is "scroll". Accepts a number of CSS pixels or a string with px, %, vh, or vw, for example 200, "200px", "50%", or "10vh".',
    },
    scrollDeltaX: {
      anyOf: [{ type: "number" }, { type: "string" }],
      description:
        'Window-relative horizontal scroll delta used only when action is "scroll". Accepts a number of CSS pixels or a string with px, %, vh, or vw, for example 200, "200px", "50%", or "10vw".',
    },
    targetSelector: {
      type: "string",
      description: 'CSS selector for the drag destination. Required when action is "drag". Selector lookup includes light DOM and open shadow roots.',
    },
  },
  required: ["tabID", "action"],
  allOf: [
    {
      if: {
        properties: { action: { const: "scroll" } },
        required: ["action"],
      },
      then: {
        anyOf: [{ required: ["scrollDeltaY"] }, { required: ["scrollDeltaX"] }],
      },
      else: {
        required: ["selector"],
      },
    },
  ],
  additionalProperties: false,
};

const scriptSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID where the script will execute in page main world." },
    script: {
      type: "string",
      description:
        "JavaScript source code whose value must be () => Promise<Record<string, unknown>>. The function is evaluated and awaited in page main world, and its resolved object becomes result.",
    },
    timeout: {
      type: "number",
      minimum: 1,
      description: "Maximum wait time in milliseconds for both bridge-side waiting and page-side script completion. Must be > 0. Defaults to 15000.",
    },
  },
  required: ["tabID", "script"],
  additionalProperties: false,
};

const fetchSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID whose current page URL is used to resolve relative requests and same-origin credential rules." },
    url: { type: "string", description: "Request URL. Absolute URLs are fetched directly; relative URLs are resolved against the current tab page URL." },
    body: {
      type: "object",
      description: "Optional fetch options payload. Omit body to perform a default GET request.",
      properties: {
        method: { type: "string", description: "HTTP method string such as GET, POST, PUT, PATCH, or DELETE." },
        headers: {
          type: "object",
          description: "Request headers object. Every key and value must be a string.",
          additionalProperties: { type: "string" },
        },
        payload: { type: "string", description: "Request body string sent as fetch body, commonly used with POST, PUT, or PATCH." },
        responseType: {
          type: "string",
          enum: ["text", "blob"],
          description: 'Response decoding mode. "text" returns textual data; "blob" returns base64-encoded binary data with mimeType and size metadata.',
        },
        credentials: {
          type: "string",
          enum: ["omit", "same-origin", "include"],
          description:
            'Fetch credentials mode. "omit" sends no credentials; "same-origin" follows the tab page origin when deciding whether cookies may be sent; "include" always includes credentials when the browser allows it.',
        },
      },
      additionalProperties: false,
    },
  },
  required: ["tabID", "url"],
  additionalProperties: false,
};

const navigateSchema = {
  type: "object",
  properties: {
    tabID: { type: "string", description: "Chrome tab ID whose navigation state will be controlled." },
    action: {
      type: "string",
      enum: ["goto", "reload", "back", "forward"],
      description:
        'Navigation action. "goto" navigates tabID to url; "reload" reloads the current page; "back" moves backward in history; "forward" moves forward in history.',
    },
    url: { type: "string", description: 'Destination URL used only when action is "goto". Ignored by "reload", "back", and "forward".' },
  },
  required: ["tabID", "action"],
  additionalProperties: false,
};

export interface BrowserBridgeRuntimeLike {
  call<T>(tool: BrowserToolName, payload: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<T>;
}

interface RenderThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
}

const renderMetaCache = new Map<string, BrowserToolRenderMeta>();

function getRenderMetaCacheKey(tool: BrowserToolName, params: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(params)}`;
}

function buildDirectRenderMeta(tool: BrowserToolName, params: Record<string, unknown>): BrowserToolRenderMeta {
  const tabID = typeof params.tabID === "string" ? params.tabID : undefined;

  if (tool === "browser_tabs") {
    return {
      action: typeof params.action === "string" ? params.action : "list",
    };
  }

  if (tool === "browser_fetch") {
    return {
      tabID,
      url: typeof params.url === "string" ? params.url : undefined,
    };
  }

  if (tool === "browser_filter") {
    return {
      tabID,
      selector: typeof params.selector === "string" ? params.selector : undefined,
    };
  }

  if (tool === "browser_act" || tool === "browser_navigate") {
    return {
      tabID,
      action: typeof params.action === "string" ? params.action : undefined,
      selector: tool === "browser_act" && typeof params.selector === "string" ? params.selector : undefined,
      url: tool === "browser_navigate" && typeof params.url === "string" ? params.url : undefined,
    };
  }

  return { tabID };
}

function renderBrowserCall(tool: BrowserToolName, params: Record<string, unknown>, theme: RenderThemeLike): Text {
  const cacheKey = getRenderMetaCacheKey(tool, params);
  const meta = renderMetaCache.get(cacheKey) ?? buildDirectRenderMeta(tool, params);
  return new Text(buildBrowserCallLine(tool, meta, theme), 0, 0);
}

async function resolveTabUrl(
  runtime: BrowserBridgeRuntimeLike,
  tabID: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!tabID) {
    return undefined;
  }

  const tabs = await runtime.call<TabInfo[]>("browser_tabs", { action: "list" }, signal);
  return tabs.find((tab) => tab.tabID === tabID)?.url;
}

async function buildRenderMeta<T extends Record<string, unknown>>(
  runtime: BrowserBridgeRuntimeLike,
  tool: BrowserToolName,
  params: T,
  signal: AbortSignal,
) {
  const direct = buildDirectRenderMeta(tool, params);

  if (tool === "browser_filter") {
    return {
      ...direct,
      tabURL: await resolveTabUrl(runtime, direct.tabID, signal),
    };
  }

  if (tool === "browser_act") {
    return {
      ...direct,
      tabURL: await resolveTabUrl(runtime, direct.tabID, signal),
    };
  }

  if (tool === "browser_navigate") {
    return {
      ...direct,
      url: direct.url ?? (await resolveTabUrl(runtime, direct.tabID, signal)),
    };
  }

  if (tool === "browser_capture" || tool === "browser_snapshot" || tool === "browser_script") {
    return {
      ...direct,
      tabURL: await resolveTabUrl(runtime, direct.tabID, signal),
    };
  }

  return direct;
}

function normalizeToolTimeout(timeout: unknown, fallback: number): number {
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

async function executeTool<T extends Record<string, unknown>>(
  runtime: BrowserBridgeRuntimeLike,
  tool: BrowserToolName,
  params: T,
  signal: AbortSignal,
  timeoutMs?: number,
) {
  const payload = await runtime.call(tool, params, signal, timeoutMs);
  const result = await renderToolResult(tool, payload);
  const cacheKey = getRenderMetaCacheKey(tool, params);

  try {
    const meta = await buildRenderMeta(runtime, tool, params, signal);
    renderMetaCache.set(cacheKey, meta);
    return attachToolRenderMeta(result, meta);
  } catch {
    renderMetaCache.set(cacheKey, buildDirectRenderMeta(tool, params));
    return result;
  }
}

function renderBrowserResult(tool: BrowserToolName, result: ExtensionToolResult, expanded: boolean, theme: RenderThemeLike): Text {
  const view = buildToolResultView(tool, result);
  const lines = expanded ? view.expanded : view.collapsed;
  if (lines.length === 0) {
    return new Text("", 0, 0);
  }

  const headerColor = view.tone === "error" ? "error" : view.tone === "warning" ? "warning" : "success";
  const bodyLines = expanded
    ? lines.map((line, index) => (index === 0 ? theme.fg(headerColor, line) : line))
    : lines.map((line, index) => {
        if (index === 0) {
          return theme.fg(headerColor, line);
        }
        return line.includes("ctrl+o to expand") ? theme.fg("muted", line) : theme.fg("dim", line);
      });
  return new Text(bodyLines.join("\n"), 0, 0);
}

export function registerBrowserTools(pi: ExtensionAPI, runtime: BrowserBridgeRuntimeLike): void {
  pi.registerTool<BrowserTabsInput>({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: 'Manage Chrome tabs. action chooses "list", "create", "delete", or "activate"; tabID targets the tab for delete/activate; url supplies the initial page for create.',
    parameters: tabsSchema,
    async execute(_toolCallId: string, params: BrowserTabsInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_tabs", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_tabs", (args ?? {}) as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_tabs", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserCaptureInput>({
    name: "browser_capture",
    label: "Browser Capture",
    description: "Capture the visible page structure of tabID as minimal HTML. maxNodes limits how many DOM and open shadow-root nodes are serialized.",
    parameters: captureSchema,
    async execute(_toolCallId: string, params: BrowserCaptureInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_capture", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_capture", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_capture", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserSnapshotInput>({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Read the full HTML snapshot of tabID, including open shadow-root content serialized into the returned markup.",
    parameters: snapshotSchema,
    async execute(_toolCallId: string, params: BrowserSnapshotInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_snapshot", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_snapshot", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_snapshot", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserFilterInput>({
    name: "browser_filter",
    label: "Browser Filter",
    description: "Capture a deduplicated minimal HTML forest from tabID. selector is matched across light DOM and open shadow roots; maxNodes limits serialization size.",
    parameters: filterSchema,
    async execute(_toolCallId: string, params: BrowserFilterInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_filter", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_filter", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_filter", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserActInput>({
    name: "browser_act",
    label: "Browser Act",
    description: 'Run one DOM action in tabID main world. selector targets the source element for non-scroll actions; action selects click/keyboard/input/focus/scroll/drag behavior; value, keys, scrollDeltaX, scrollDeltaY, and targetSelector are action-specific.',
    parameters: actSchema,
    async execute(_toolCallId: string, params: BrowserActInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_act", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_act", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_act", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserScriptInput>({
    name: "browser_script",
    label: "Browser Script",
    description: "Execute a main-world script in tabID. script must be source for () => Promise<Record<string, unknown>>; timeout sets the maximum wait in milliseconds.",
    parameters: scriptSchema,
    async execute(_toolCallId: string, params: BrowserScriptInput, signal: AbortSignal) {
      return executeTool(
        runtime,
        "browser_script",
        params as unknown as Record<string, unknown>,
        signal,
        normalizeToolTimeout(params.timeout, TOOL_TIMEOUT_MS.browser_script),
      );
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_script", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_script", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserFetchInput>({
    name: "browser_fetch",
    label: "Browser Fetch",
    description: "Execute a network request relative to tabID page URL from the extension service worker. body.method, headers, payload, responseType, and credentials map to fetch options.",
    parameters: fetchSchema,
    async execute(_toolCallId: string, params: BrowserFetchInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_fetch", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_fetch", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_fetch", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });

  pi.registerTool<BrowserNavigateInput>({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: 'Control navigation for tabID. action chooses "goto", "reload", "back", or "forward"; url is used only when action is "goto".',
    parameters: navigateSchema,
    async execute(_toolCallId: string, params: BrowserNavigateInput, signal: AbortSignal) {
      return executeTool(runtime, "browser_navigate", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      return renderBrowserCall("browser_navigate", args as unknown as Record<string, unknown>, theme as RenderThemeLike);
    },
    renderResult(result, { expanded }, theme) {
      return renderBrowserResult("browser_navigate", result, Boolean(expanded), theme as RenderThemeLike);
    },
  });
}
