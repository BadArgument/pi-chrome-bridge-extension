import type { HelloPayload, TabInfo } from "../shared/browser-types";
import { DEFAULT_HEARTBEAT_MS, DEFAULT_WS_URL } from "../shared/limits";

export interface BridgeConfig {
  wsUrl: string;
  heartbeatMs: number;
}

export type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "reconnecting";

export interface ConnectionSnapshot {
  state: ConnectionState;
  lastConnectedAt?: number;
  lastError?: string;
  lastInfo?: string;
}

export interface OptionsState {
  config: BridgeConfig;
  connection: ConnectionSnapshot;
  tabs: TabInfo[];
  clientInfo?: HelloPayload;
}

export const STORAGE_KEY = "pi-browser-bridge-config";

export const DEFAULT_CONFIG: BridgeConfig = {
  wsUrl: DEFAULT_WS_URL,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
};

export async function loadConfig(): Promise<BridgeConfig> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const config = data[STORAGE_KEY] as Partial<BridgeConfig> | undefined;
  return normalizeConfig(config);
}

export async function saveConfig(config: BridgeConfig): Promise<BridgeConfig> {
  const normalized = normalizeConfig(config);
  await chrome.storage.local.set({
    [STORAGE_KEY]: normalized,
  });
  return normalized;
}

function normalizeConfig(config?: Partial<BridgeConfig>): BridgeConfig {
  return {
    wsUrl: config?.wsUrl?.trim() || DEFAULT_CONFIG.wsUrl,
    heartbeatMs:
      typeof config?.heartbeatMs === "number" && Number.isFinite(config.heartbeatMs) && config.heartbeatMs > 250
        ? Math.round(config.heartbeatMs)
        : DEFAULT_CONFIG.heartbeatMs,
  };
}
