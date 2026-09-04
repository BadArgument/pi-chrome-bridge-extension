import type { BrowserToolName, HeartbeatPayload, HelloPayload, PeerHelloPayload } from "./browser-types";

export type BridgeMessageKind = "hello" | "heartbeat" | "request" | "response" | "event" | "error";
export type BridgeSource = "pi" | "chrome-sw" | "chrome-tab";

export type BridgeErrorCode =
  | "CHROME_NOT_CONNECTED"
  | "BRIDGE_TIMEOUT"
  | "INVALID_REQUEST"
  | "TAB_NOT_FOUND"
  | "TAB_NOT_INJECTABLE"
  | "EXECUTOR_NOT_READY"
  | "PAGE_META_FAILED"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_NOT_INTERACTABLE"
  | "DRAG_TARGET_NOT_FOUND"
  | "ACT_DISPATCH_FAILED"
  | "SNAPSHOT_FAILED"
  | "CAPTURE_FAILED"
  | "INJECT_DISPATCH_FAILED"
  | "FETCH_FAILED"
  | "NAVIGATION_FAILED"
  | "LOG_UNAVAILABLE";

export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface BridgeMessage<T = unknown> {
  id: string;
  replyTo?: string;
  kind: BridgeMessageKind;
  source: BridgeSource;
  tabID?: number;
  tool?: BrowserToolName;
  ts: number;
  payload?: T;
  error?: BridgeErrorPayload;
}

export interface ExecutorEventPayload {
  type: "executor_attached" | "executor_detached" | "log_buffer_updated" | "tabs_changed";
  details?: unknown;
}

export type KnownPayload = HelloPayload | PeerHelloPayload | HeartbeatPayload | ExecutorEventPayload | Record<string, unknown>;

export function createMessage<T>(message: Omit<BridgeMessage<T>, "id" | "ts"> & Partial<Pick<BridgeMessage<T>, "id" | "ts">>): BridgeMessage<T> {
  return {
    id: message.id ?? createID(),
    ts: message.ts ?? Date.now(),
    ...message,
  };
}

export function createBridgeError(code: BridgeErrorCode, message: string, details?: unknown, retryable?: boolean): BridgeErrorPayload {
  return {
    code,
    message,
    retryable,
    details,
  };
}

export function parseBridgeMessage(raw: string): BridgeMessage {
  const parsed = JSON.parse(raw) as BridgeMessage;
  if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string" || typeof parsed.source !== "string") {
    throw new Error("Invalid bridge message");
  }
  return parsed;
}

export function createID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
