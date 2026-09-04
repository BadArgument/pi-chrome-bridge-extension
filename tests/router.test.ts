import test from "node:test";
import assert from "node:assert/strict";
import { routeBridgeRequest } from "../chrome-extension/src/sw/router";
import { createMessage } from "../pi-extension/shared/protocol";

test("browser_tabs activate marks tab active without focusing window", async () => {
  let windowsUpdateCalls = 0;
  let markedActive: number | undefined;
  let upsertedTab: chrome.tabs.Tab | undefined;

  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
    tabs: {
      update: async (tabId: number, props: chrome.tabs.UpdateProperties) => {
        assert.equal(tabId, 42);
        assert.deepEqual(props, { active: true });
        return { id: 42, windowId: 7, active: true, url: "https://example.com", title: "Example" };
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      update: async () => {
        windowsUpdateCalls += 1;
        return {} as chrome.windows.Window;
      },
    },
  } as unknown as typeof chrome;

  const registry = {
    upsert(tab: chrome.tabs.Tab) {
      upsertedTab = tab;
    },
    markActive(tabId: number) {
      markedActive = tabId;
    },
  } as unknown as Parameters<typeof routeBridgeRequest>[1];

  const response = await routeBridgeRequest(
    createMessage({
      kind: "request",
      source: "pi",
      tool: "browser_tabs",
      payload: { action: "activate", tabID: "42" },
    }),
    registry,
  );

  assert.deepEqual(response.payload, { ok: true, action: "activate", tabID: "42" });
  assert.equal(markedActive, 42);
  assert.equal(upsertedTab?.id, 42);
  assert.equal(windowsUpdateCalls, 0);
});

test("browser_fetch runs in service worker with tab-relative same-origin credentials", async () => {
  let fetchedUrl = "";
  let fetchCredentials: RequestCredentials | undefined;
  let upsertedTab: chrome.tabs.Tab | undefined;
  const originalFetch = globalThis.fetch;

  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
    tabs: {
      get: async (tabId: number) => {
        assert.equal(tabId, 7);
        return { id: 7, url: "https://example.com/path/page", title: "Example", active: true };
      },
    },
  } as unknown as typeof chrome;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchedUrl = String(input);
    fetchCredentials = init?.credentials;
    return new Response("ok", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const registry = {
      get(tabId: number) {
        assert.equal(tabId, 7);
        return {
          tabID: "7",
          windowId: 1,
          url: "https://example.com/path/page",
          active: true,
          injectable: false,
          executorReady: false,
          lastSeenAt: Date.now(),
        };
      },
      upsert(tab: chrome.tabs.Tab) {
        upsertedTab = tab;
      },
    } as unknown as Parameters<typeof routeBridgeRequest>[1];

    const response = await routeBridgeRequest(
      createMessage({
        kind: "request",
        source: "pi",
        tool: "browser_fetch",
        tabID: 7,
        payload: { tabID: "7", url: "/api/data" },
      }),
      registry,
    );

    assert.equal(fetchedUrl, "https://example.com/api/data");
    assert.equal(fetchCredentials, "include");
    assert.equal(upsertedTab?.id, 7);
    assert.deepEqual(response.payload, {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
      data: "ok",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
