import type { BridgeMessage } from "../shared/protocol";
import { loadConfig, saveConfig, type BridgeConfig, type OptionsState } from "./config";
import { routeBridgeRequest, ensureExecutor } from "./router";
import { TabRegistry } from "./tab-registry";
import { BridgeWebSocketClient } from "./ws-client";

const registry = new TabRegistry();
let config: BridgeConfig | null = null;
let wsClient: BridgeWebSocketClient | null = null;
let initialized = false;
let listenersRegistered = false;

async function initialize(): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;
  registerListeners();
  config = await loadConfig();
  await registry.refreshAllTabs();
  await injectKnownTabs();
  wsClient = new BridgeWebSocketClient(config, {
    getHelloPayload: () => ({
      role: "chrome",
      extensionVersion: chrome.runtime.getManifest().version,
      wsUrl: config?.wsUrl ?? "",
      heartbeatMs: config?.heartbeatMs ?? 0,
      tabsSummary: registry.summary(),
    }),
    onRequest: async (message: BridgeMessage) => routeBridgeRequest(message, registry),
  });
  wsClient.start();
}

async function injectKnownTabs(): Promise<void> {
  for (const tab of registry.list()) {
    if (!tab.injectable) {
      continue;
    }
    try {
      await ensureExecutor(Number.parseInt(tab.tabID, 10), registry);
    } catch {
      // ignore restricted or transient tabs
    }
  }
}

function registerListeners(): void {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  chrome.runtime.onInstalled.addListener(() => {
    void initialize();
  });

  chrome.runtime.onStartup.addListener(() => {
    void initialize();
  });

  chrome.tabs.onCreated.addListener((tab) => {
    registry.upsert(tab);
    if (tab.id !== undefined && (tab.status === "complete" || !tab.status)) {
      void tryInject(tab.id);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    registry.upsert(tab);
    if (changeInfo.status === "loading") {
      registry.setExecutorReady(tabId, false);
      return;
    }
    if (changeInfo.status === "complete") {
      void tryInject(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    registry.remove(tabId);
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    registry.markActive(activeInfo.tabId);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "pi-browser:executor-ready") {
      if (sender.tab?.id !== undefined) {
        registry.setExecutorReady(sender.tab.id, true);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "pi-browser:options:get-state") {
      void getOptionsState().then((state) => sendResponse(state));
      return true;
    }

    if (message?.type === "pi-browser:options:save-config") {
      void updateConfig(message.config as BridgeConfig)
        .then((state) => sendResponse(state))
        .catch((error) =>
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    return false;
  });
}

async function tryInject(tabId: number): Promise<void> {
  try {
    await ensureExecutor(tabId, registry);
  } catch {
    // ignore
  }
}

async function updateConfig(nextConfig: BridgeConfig): Promise<OptionsState> {
  config = await saveConfig(nextConfig);
  if (!wsClient) {
    wsClient = new BridgeWebSocketClient(config, {
      getHelloPayload: () => ({
        role: "chrome",
        extensionVersion: chrome.runtime.getManifest().version,
        wsUrl: config?.wsUrl ?? "",
        heartbeatMs: config?.heartbeatMs ?? 0,
        tabsSummary: registry.summary(),
      }),
      onRequest: async (message: BridgeMessage) => routeBridgeRequest(message, registry),
    });
    wsClient.start();
  } else {
    wsClient.updateConfig(config);
  }
  return getOptionsState();
}

async function getOptionsState(): Promise<OptionsState> {
  if (!config) {
    config = await loadConfig();
  }
  return {
    config,
    connection: wsClient?.snapshot() ?? { state: "idle" },
    tabs: registry.list(),
  };
}

void initialize();
