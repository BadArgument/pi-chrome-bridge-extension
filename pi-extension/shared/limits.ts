export const DEFAULT_WS_HOST = "127.0.0.1";
export const DEFAULT_WS_PORT = 29180;
export const DEFAULT_WS_PATH = "/agent";
export const DEFAULT_WS_URL = `ws://${DEFAULT_WS_HOST}:${DEFAULT_WS_PORT}${DEFAULT_WS_PATH}`;
export const DEFAULT_HEARTBEAT_MS = 2500;

export const MAX_INLINE_TEXT = 24 * 1024;
export const MAX_INLINE_HTML = 24 * 1024;
export const MAX_INLINE_JSON = 24 * 1024;
export const DEFAULT_CAPTURE_MAX_NODES = 1048576;

export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000] as const;

export const TOOL_TIMEOUT_MS = {
  browser_tabs: 3000,
  browser_capture: 5000,
  browser_filter: 5000,
  browser_snapshot: 8000,
  browser_act: 5000,
  browser_script: 15000,
  browser_fetch: 15000,
  browser_navigate: 15000,
} as const;
