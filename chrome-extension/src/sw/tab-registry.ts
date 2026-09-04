import type { TabInfo } from "../shared/browser-types";

export interface TabRuntimeState {
  tabID: string;
  windowId: number;
  url?: string;
  title?: string;
  status?: string;
  active: boolean;
  injectable: boolean;
  executorReady: boolean;
  restrictedReason?: string;
  lastSeenAt: number;
}

function analyzeUrl(url?: string): Pick<TabRuntimeState, "injectable" | "restrictedReason"> {
  if (!url) {
    return { injectable: false, restrictedReason: "EMPTY_URL" };
  }
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  ) {
    return { injectable: false, restrictedReason: "RESTRICTED_PAGE" };
  }
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")) {
    return { injectable: true };
  }
  return { injectable: false, restrictedReason: "UNSUPPORTED_SCHEME" };
}

export class TabRegistry {
  private readonly tabs = new Map<number, TabRuntimeState>();

  async refreshAllTabs(): Promise<void> {
    const tabs = await chrome.tabs.query({});
    this.tabs.clear();
    for (const tab of tabs) {
      this.upsert(tab);
    }
  }

  upsert(tab: chrome.tabs.Tab): void {
    if (tab.id === undefined) {
      return;
    }

    const current = this.tabs.get(tab.id);
    const analyzed = analyzeUrl(tab.url);
    this.tabs.set(tab.id, {
      tabID: String(tab.id),
      windowId: tab.windowId ?? current?.windowId ?? chrome.windows.WINDOW_ID_NONE,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      active: tab.active ?? false,
      injectable: analyzed.injectable,
      executorReady: current?.executorReady ?? false,
      restrictedReason: analyzed.restrictedReason,
      lastSeenAt: Date.now(),
    });
  }

  remove(tabId: number): void {
    this.tabs.delete(tabId);
  }

  markActive(tabId: number): void {
    for (const [id, tab] of this.tabs.entries()) {
      tab.active = id === tabId;
    }
  }

  setExecutorReady(tabId: number, ready: boolean): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    tab.executorReady = ready;
    tab.lastSeenAt = Date.now();
  }

  get(tabId: number): TabRuntimeState | undefined {
    return this.tabs.get(tabId);
  }

  list(): TabInfo[] {
    return Array.from(this.tabs.values())
      .sort((left, right) => Number(right.active) - Number(left.active) || Number(left.tabID) - Number(right.tabID))
      .map((tab) => ({
        tabID: tab.tabID,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        injectable: tab.injectable,
        executorReady: tab.executorReady,
        restrictedReason: tab.restrictedReason,
      }));
  }

  summary() {
    const values = Array.from(this.tabs.values());
    return {
      total: values.length,
      injectable: values.filter((tab) => tab.injectable).length,
      executorReady: values.filter((tab) => tab.executorReady).length,
      restricted: values.filter((tab) => !tab.injectable).length,
    };
  }
}
