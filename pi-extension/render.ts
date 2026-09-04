import type { ExtensionToolResult } from "@earendil-works/pi-coding-agent";
import type {
  BrowserActResult,
  BrowserFetchBlobResult,
  BrowserFetchResult,
  BrowserNavigateResult,
  BrowserScriptResult,
  BrowserTabsMutationResult,
  BrowserTabsResult,
  BrowserToolName,
  CaptureResult,
  TabInfo,
} from "./shared/browser-types";
import { MAX_INLINE_HTML, MAX_INLINE_JSON, MAX_INLINE_TEXT } from "./shared/limits";
import { writeTempBufferFile, writeTempTextFile } from "./temp-file";

const COLLAPSED_PREVIEW_CHARS = 160;
const COLLAPSED_TAB_LIMIT = 3;

export interface ToolResultView {
  tone: "success" | "error" | "warning";
  collapsed: string[];
  expanded: string[];
}

export interface BrowserResultThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BrowserToolRenderMeta {
  tabID?: string;
  tabURL?: string;
  url?: string;
  action?: string;
  selector?: string;
}

interface ToolResultDetailsEnvelope<T = unknown> {
  payload: T;
  meta?: BrowserToolRenderMeta;
}

function unwrapToolResultDetails<T>(details: unknown): ToolResultDetailsEnvelope<T> {
  if (details && typeof details === "object" && "payload" in details) {
    const envelope = details as ToolResultDetailsEnvelope<T>;
    return {
      payload: envelope.payload,
      meta: envelope.meta,
    };
  }

  return {
    payload: details as T,
  };
}

export function attachToolRenderMeta(result: ExtensionToolResult, meta: BrowserToolRenderMeta): ExtensionToolResult {
  return {
    ...result,
    details: {
      payload: result.details,
      meta,
    } satisfies ToolResultDetailsEnvelope,
  };
}

export function getToolResultMeta(result: ExtensionToolResult): BrowserToolRenderMeta | undefined {
  return unwrapToolResultDetails(result.details).meta;
}

export function buildBrowserCallLine(tool: BrowserToolName, meta: BrowserToolRenderMeta | undefined, theme: BrowserResultThemeLike): string {
  const parts = [theme.fg("toolTitle", theme.bold(tool))];
  const action = theme.fg("toolTitle", theme.bold(meta?.action ?? "list"));

  if (tool === "browser_tabs") {
    parts.push(action);
    return parts.join(" ");
  }

  if (tool === "browser_fetch") {
    return meta?.url ? [...parts, theme.fg("dim", meta.url)].join(" ") : parts.join(" ");
  }

  if (tool === "browser_navigate") {
    if (meta?.action) {
      parts.push(action);
    }
    return meta?.url ? [...parts, theme.fg("dim", meta.url)].join(" ") : parts.join(" ");
  }

  if (tool === "browser_filter") {
    if (meta?.selector) {
      parts.push(theme.fg("accent", meta.selector));
    }
    return meta?.tabURL ? [...parts, theme.fg("dim", meta.tabURL)].join(" ") : parts.join(" ");
  }

  if (tool === "browser_act") {
    if (meta?.action) {
      parts.push(action);
    }
    if (meta?.selector) {
      parts.push(theme.fg("accent", meta.selector));
    }
    return meta?.tabURL ? [...parts, theme.fg("dim", meta.tabURL)].join(" ") : parts.join(" ");
  }

  if (tool === "browser_capture" || tool === "browser_snapshot" || tool === "browser_script") {
    return meta?.tabURL ? [...parts, theme.fg("dim", meta.tabURL)].join(" ") : parts.join(" ");
  }

  return parts.join(" ");
}

export function buildBrowserTitleLine(tool: BrowserToolName, result: ExtensionToolResult, theme: BrowserResultThemeLike): string {
  return buildBrowserCallLine(tool, getToolResultMeta(result), theme);
}

function toTextResult(text: string, details: unknown): ExtensionToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function getTextContent(result: ExtensionToolResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

function compactPreview(text: string, maxChars = COLLAPSED_PREVIEW_CHARS): string | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}

function appendExpandHint(lines: string[], expandable: boolean, label = "content"): string[] {
  if (!expandable) {
    return lines;
  }
  return [...lines, `... (${label}, ctrl+o to expand)`];
}

function hasExpandableBody(text: string, tempFile?: string): boolean {
  return Boolean(tempFile) || text.length > COLLAPSED_PREVIEW_CHARS || text.includes("\n");
}

async function inlineOrTemp(text: string, maxInline: number, extension: string) {
  if (text.length <= maxInline) {
    return {
      text,
      details: {
        truncated: false,
      },
    };
  }

  const tempFile = await writeTempTextFile(text, extension);
  return {
    text: `${text.slice(0, maxInline)}\n\n[truncated=true tempFile=${tempFile}]`,
    details: {
      truncated: true,
      tempFile,
    },
  };
}

async function renderFetchResult(payload: BrowserFetchResult): Promise<ExtensionToolResult> {
  if (!payload.ok) {
    return toTextResult(JSON.stringify(payload), payload);
  }

  if ("encoding" in payload && payload.encoding === "base64") {
    const blobPayload = payload as BrowserFetchBlobResult;
    const tempFile = await writeTempBufferFile(Buffer.from(blobPayload.data, "base64"), guessExtension(blobPayload.mimeType));
    const details = {
      ok: true,
      status: blobPayload.status,
      statusText: blobPayload.statusText,
      headers: blobPayload.headers,
      mimeType: blobPayload.mimeType,
      size: blobPayload.size,
      tempFile,
    };
    return toTextResult(JSON.stringify(details), details);
  }

  const rendered = await inlineOrTemp(payload.data, MAX_INLINE_TEXT, ".txt");
  const details = {
    ...payload,
    ...rendered.details,
  };
  return toTextResult(JSON.stringify({ ...details, data: rendered.text }), details);
}

function guessExtension(mimeType?: string): string {
  if (!mimeType) {
    return ".bin";
  }
  if (mimeType.includes("json")) {
    return ".json";
  }
  if (mimeType.includes("html")) {
    return ".html";
  }
  if (mimeType.includes("png")) {
    return ".png";
  }
  if (mimeType.includes("jpeg")) {
    return ".jpg";
  }
  if (mimeType.includes("svg")) {
    return ".svg";
  }
  return ".bin";
}

async function renderStructured(payload: unknown): Promise<ExtensionToolResult> {
  const serialized = JSON.stringify(payload);
  const rendered = await inlineOrTemp(serialized, MAX_INLINE_JSON, ".json");
  return toTextResult(rendered.text, payload);
}

async function renderHtmlPayload(payload: { html: string }): Promise<ExtensionToolResult> {
  const rendered = await inlineOrTemp(payload.html, MAX_INLINE_HTML, ".html");
  return toTextResult(rendered.text, {
    ...payload,
    ...rendered.details,
  });
}

function formatTabLine(tab: TabInfo): string {
  const flags: string[] = [];
  if (tab.active) {
    flags.push("active");
  }
  if (tab.executorReady) {
    flags.push("ready");
  } else if (tab.injectable === false) {
    flags.push(tab.restrictedReason ? `restricted:${tab.restrictedReason}` : "restricted");
  } else if (tab.injectable) {
    flags.push("injectable");
  }

  const title = (tab.title || "(untitled)").replace(/\s+/g, " ").trim();
  const url = tab.url ? ` · ${tab.url}` : "";
  const flagText = flags.length ? ` [${flags.join(", ")}]` : "";
  return `${tab.tabID}${flagText} ${title}${url}`;
}

function buildTabsView(details: BrowserTabsResult, result: ExtensionToolResult): ToolResultView {
  if (Array.isArray(details)) {
    const header = `${details.length} tabs`;
    const lines = details.map(formatTabLine);
    const collapsed = [header, ...lines.slice(0, COLLAPSED_TAB_LIMIT)];
    const moreTabs = lines.length - Math.min(lines.length, COLLAPSED_TAB_LIMIT);
    if (moreTabs > 0) {
      collapsed.push(`... (${moreTabs} more tabs, ctrl+o to expand)`);
    }
    return {
      tone: "success",
      collapsed,
      expanded: lines.length > 0 ? [header, ...lines] : [header],
    };
  }

  const mutation = details as BrowserTabsMutationResult;
  const header = mutation.ok ? `ok${mutation.tabID ? ` · tab ${mutation.tabID}` : ""}` : "failed";
  const text = getTextContent(result);
  const expanded = text ? [header, text] : [header];
  return {
    tone: mutation.ok ? "success" : "error",
    collapsed: [header],
    expanded,
  };
}

function buildHtmlView(_tool: BrowserToolName, details: Partial<CaptureResult> & { html?: string; truncated?: boolean; tempFile?: string }, result: ExtensionToolResult): ToolResultView {
  const text = getTextContent(result);
  const html = typeof details.html === "string" ? details.html : text;
  const parts = [`${html.length} chars`];
  if (typeof details.rootCount === "number") {
    parts.push(`${details.rootCount} roots`);
  }
  if (typeof details.totalNodes === "number") {
    parts.push(`${details.totalNodes} nodes`);
  }
  if (details.truncated) {
    parts.push("truncated");
  }
  const header = parts.join(" · ");
  const preview = compactPreview(text);
  const collapsed = preview ? [header, preview] : [header];
  const expanded = [header];
  if (details.tempFile) {
    expanded.push(`tempFile: ${details.tempFile}`);
  }
  if (text) {
    expanded.push(text);
  }
  return {
    tone: "success",
    collapsed: appendExpandHint(collapsed, hasExpandableBody(text, details.tempFile), "HTML hidden"),
    expanded,
  };
}

interface FetchRenderDetails {
  ok: boolean;
  status?: number;
  statusText?: string;
  error?: string;
  mimeType?: string;
  size?: number;
  data?: string;
  truncated?: boolean;
  tempFile?: string;
}

function buildFetchView(details: FetchRenderDetails, result: ExtensionToolResult): ToolResultView {
  if (details.ok === false) {
    const header = `${details.status} ${details.statusText}`.trim();
    const collapsed = details.error ? [header, details.error] : [header];
    const expanded = details.error ? [header, details.error, getTextContent(result)].filter(Boolean) : [header, getTextContent(result)].filter(Boolean);
    return {
      tone: "error",
      collapsed,
      expanded,
    };
  }

  const parts = [`${details.status ?? "?"} ${details.statusText ?? ""}`.trim()];
  if (typeof details.size === "number") {
    parts.push(`${details.size} bytes`);
  } else if (typeof details.data === "string") {
    parts.push(`${details.data.length} chars`);
  }
  if (details.mimeType) {
    parts.push(details.mimeType);
  }
  if (details.truncated) {
    parts.push("truncated");
  }
  const header = parts.join(" · ");
  const previewSource = typeof details.data === "string" ? details.data : getTextContent(result);
  const preview = compactPreview(previewSource);
  const collapsed = preview ? [header, preview] : [header];
  const expanded = [header];
  if (details.tempFile) {
    expanded.push(`tempFile: ${details.tempFile}`);
  }
  const body = getTextContent(result);
  if (body) {
    expanded.push(body);
  }
  return {
    tone: "success",
    collapsed: appendExpandHint(collapsed, hasExpandableBody(previewSource, details.tempFile), "fetch body hidden"),
    expanded,
  };
}

function buildScriptView(details: BrowserScriptResult, result: ExtensionToolResult): ToolResultView {
  const header = details.ok ? "ok" : "failed";
  const collapsed = [header];
  if (details.error) {
    collapsed.push(details.error);
  } else if (details.result) {
    const keys = Object.keys(details.result);
    collapsed.push(keys.length > 0 ? `result keys: ${keys.join(", ")}` : "result keys: (empty object)");
  }
  const expanded = [header];
  const text = getTextContent(result);
  if (text) {
    expanded.push(text);
  }
  return {
    tone: details.ok ? "success" : "error",
    collapsed,
    expanded,
  };
}

function buildOkErrorView(
  _tool: BrowserToolName,
  details: BrowserActResult | BrowserNavigateResult | BrowserTabsMutationResult,
  result: ExtensionToolResult,
): ToolResultView {
  const ok = details.ok !== false;
  const header = ok ? "ok" : "failed";
  const collapsed = [header];
  const message = "message" in details ? details.message : undefined;
  const error = "error" in details ? details.error : undefined;
  if (error) {
    collapsed.push(error);
  } else if (message) {
    collapsed.push(message);
  }
  const expanded = [header];
  const text = getTextContent(result);
  if (text) {
    expanded.push(text);
  }
  return {
    tone: ok ? "success" : "error",
    collapsed,
    expanded,
  };
}

function buildStructuredView(_tool: BrowserToolName, result: ExtensionToolResult): ToolResultView {
  const text = getTextContent(result);
  const preview = compactPreview(text);
  const header = "result";
  const collapsed = preview ? [header, preview] : [header];
  const expanded = text ? [header, text] : [header];
  return {
    tone: "success",
    collapsed: appendExpandHint(collapsed, hasExpandableBody(text), "result hidden"),
    expanded,
  };
}

export function buildToolResultView(tool: BrowserToolName, result: ExtensionToolResult): ToolResultView {
  const { payload: details } = unwrapToolResultDetails(result.details);

  if (tool === "browser_capture" || tool === "browser_filter" || tool === "browser_snapshot") {
    return buildHtmlView(tool, details as Partial<CaptureResult> & { html?: string; truncated?: boolean; tempFile?: string }, result);
  }

  if (tool === "browser_tabs") {
    return buildTabsView(details as BrowserTabsResult, result);
  }

  if (tool === "browser_fetch") {
    return buildFetchView(
      details as FetchRenderDetails,
      result,
    );
  }

  if (tool === "browser_script") {
    return buildScriptView(details as BrowserScriptResult, result);
  }

  if (tool === "browser_act" || tool === "browser_navigate") {
    return buildOkErrorView(tool, details as BrowserActResult | BrowserNavigateResult, result);
  }

  return buildStructuredView(tool, result);
}

export async function renderToolResult(tool: BrowserToolName, payload: unknown): Promise<ExtensionToolResult> {
  if (tool === "browser_capture" || tool === "browser_filter" || tool === "browser_snapshot") {
    return renderHtmlPayload(payload as { html: string });
  }

  if (tool === "browser_fetch") {
    return renderFetchResult(payload as BrowserFetchResult);
  }

  return renderStructured(payload);
}
