export type BrowserToolName =
  | "browser_tabs"
  | "browser_capture"
  | "browser_filter"
  | "browser_snapshot"
  | "browser_act"
  | "browser_script"
  | "browser_fetch"
  | "browser_navigate";

export interface TabInfo {
  tabID: string;
  title?: string;
  url?: string;
  active: boolean;
  injectable?: boolean;
  executorReady?: boolean;
  restrictedReason?: string;
}

export type BrowserTabsAction = "list" | "create" | "delete" | "activate";

export interface BrowserTabsInput {
  action?: BrowserTabsAction;
  tabID?: string;
  url?: string;
}

export interface BrowserTabsMutationResult {
  ok: boolean;
  action: Exclude<BrowserTabsAction, "list">;
  tabID?: string;
}

export type BrowserTabsResult = TabInfo[] | BrowserTabsMutationResult;

export interface CaptureResult {
  html: string;
  rootCount: number;
  totalNodes: number;
}

export interface SnapshotResult {
  html: string;
}

export type BrowserActAction =
  | "click"
  | "keydown"
  | "keyup"
  | "keypress"
  | "input"
  | "focus"
  | "scroll"
  | "drag";

export type ScrollDeltaValue = number | string;

export interface BrowserActInput {
  tabID: string;
  selector?: string;
  action: BrowserActAction;
  value?: string;
  keys?: string[];
  scrollDeltaY?: ScrollDeltaValue;
  scrollDeltaX?: ScrollDeltaValue;
  targetSelector?: string;
}

export interface BrowserActResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface BrowserScriptInput {
  tabID: string;
  script: string;
  timeout?: number;
}

export interface BrowserScriptResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export interface BrowserFetchInput {
  tabID: string;
  url: string;
  body?: {
    method?: string;
    headers?: Record<string, string>;
    payload?: string;
    responseType?: "text" | "blob";
    credentials?: RequestCredentials;
  };
}

export interface BrowserFetchTextResult {
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: string;
}

export interface BrowserFetchBlobResult {
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType?: string;
  size: number;
  data: string;
  encoding: "base64";
}

export interface BrowserFetchErrorResult {
  ok: false;
  status: number;
  statusText: string;
  error: string;
}

export type BrowserFetchResult = BrowserFetchTextResult | BrowserFetchBlobResult | BrowserFetchErrorResult;

export interface BrowserNavigateInput {
  tabID: string;
  action: "goto" | "reload" | "back" | "forward";
  url?: string;
}

export interface BrowserNavigateResult {
  ok: boolean;
}

export interface BrowserCaptureInput {
  tabID: string;
  maxNodes?: number;
}

export interface BrowserFilterInput {
  tabID: string;
  selector: string;
  maxNodes?: number;
}

export interface BrowserSnapshotInput {
  tabID: string;
}

export type BridgeClientRole = "chrome" | "peer";

interface HelloPayloadBase {
  role: BridgeClientRole;
}

export interface HelloPayload extends HelloPayloadBase {
  role: "chrome";
  extensionVersion: string;
  wsUrl: string;
  heartbeatMs: number;
  tabsSummary: {
    total: number;
    injectable: number;
    executorReady: number;
    restricted: number;
  };
}

/**
 * Handshake sent by a follower (peer) process that reuses the leader's bridge.
 * Chrome and peer now share the same hello shape and are distinguished by
 * payload.role.
 */
export interface PeerHelloPayload extends HelloPayloadBase {
  role: "peer";
  peerId: string;
}

export interface HeartbeatPayload {
  seq: number;
  sentAt: number;
}
