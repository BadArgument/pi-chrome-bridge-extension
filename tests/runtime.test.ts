import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeRuntime } from "../pi-extension/runtime";
import type { BrowserToolName } from "../pi-extension/shared/browser-types";
import type { BrowserBridgeServer } from "../pi-extension/server";
import type { RemoteBridgeClientLike } from "../pi-extension/runtime";

function createAddrInUseError(message = "address in use"): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EADDRINUSE" });
}

test("BrowserBridgeRuntime leaderOnly mode exits idle when another leader already exists", async () => {
  let remoteClientCreated = false;

  const runtime = new BrowserBridgeRuntime(
    () =>
      ({
        async start() {
          throw createAddrInUseError();
        },
      }) as unknown as BrowserBridgeServer,
    () => {
      remoteClientCreated = true;
      return {
        connected: false,
        async connect() {
          throw new Error("should not connect follower in leaderOnly mode");
        },
        async request() {
          throw new Error("unexpected request");
        },
        close() {
          // noop
        },
      };
    },
    "peer-test-id",
    0,
  );

  await runtime.ensureStarted({ leaderOnly: true });

  const status = runtime.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.role, "idle");
  assert.equal(status.startupIssue?.message, "leader already running");
  assert.equal(remoteClientCreated, false);
});

test("BrowserBridgeRuntime falls back to follower mode on EADDRINUSE and proxies requests", async () => {
  let remoteConnectArgs: { host: string; port: number; path: string } | null = null;
  let remoteRequest: { tool: BrowserToolName; payload: Record<string, unknown>; timeoutMs: number } | null = null;

  const runtime = new BrowserBridgeRuntime(
    () =>
      ({
        async start() {
          throw createAddrInUseError();
        },
      }) as unknown as BrowserBridgeServer,
    () => ({
      connected: true,
      async connect(host: string, port: number, path: string) {
        remoteConnectArgs = { host, port, path };
      },
      async request(tool: BrowserToolName, payload: Record<string, unknown>, timeoutMs: number) {
        remoteRequest = { tool, payload, timeoutMs };
        return { ok: true, via: "leader" };
      },
      close() {
        // noop
      },
    }),
    "peer-test-id",
    0,
  );

  await runtime.ensureStarted();

  const status = runtime.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.role, "follower");
  assert.equal(status.peerId, "peer-test-id");
  assert.deepEqual(remoteConnectArgs, { host: "127.0.0.1", port: 29180, path: "/agent" });

  const result = await runtime.call<{ ok: boolean; via: string }>("browser_tabs", { action: "list" });
  assert.deepEqual(result, { ok: true, via: "leader" });
  assert.deepEqual(remoteRequest, {
    tool: "browser_tabs",
    payload: { action: "list" },
    timeoutMs: 3000,
  });
});

test("BrowserBridgeRuntime promotes a follower to leader after the leader disconnects", async () => {
  let disconnectLeader: (() => void) | undefined;
  let serverStartCount = 0;
  let leaderDispatchCount = 0;
  let followerRequestCount = 0;

  const runtime = new BrowserBridgeRuntime(
    () => {
      serverStartCount += 1;
      if (serverStartCount === 1) {
        return {
          async start() {
            throw createAddrInUseError();
          },
        } as unknown as BrowserBridgeServer;
      }
      return {
        async start() {
          // noop
        },
        async stop() {
          // noop
        },
        async dispatch() {
          leaderDispatchCount += 1;
          return { ok: true, via: "new-leader" };
        },
        status() {
          return {
            wsUrl: "ws://127.0.0.1:29180/agent",
            connected: false,
            ready: false,
            peerCount: 0,
            role: "leader" as const,
          };
        },
      } as unknown as BrowserBridgeServer;
    },
    () => {
      let connected = true;
      const client: RemoteBridgeClientLike = {
        get connected() {
          return connected;
        },
        async connect() {
          connected = true;
        },
        async request() {
          followerRequestCount += 1;
          return { ok: true, via: "old-leader" };
        },
        close() {
          connected = false;
        },
        setDisconnectHandler(handler: () => void) {
          disconnectLeader = () => {
            connected = false;
            handler();
          };
        },
      };
      return client;
    },
    "peer-test-id",
    0,
  );

  await runtime.ensureStarted();
  assert.equal(runtime.getStatus().role, "follower");

  disconnectLeader?.();
  await runtime.ensureStarted();

  const status = runtime.getStatus();
  assert.equal(status.role, "leader");

  const result = await runtime.call<{ ok: boolean; via: string }>("browser_tabs", { action: "list" });
  assert.deepEqual(result, { ok: true, via: "new-leader" });
  assert.equal(leaderDispatchCount, 1);
  assert.equal(followerRequestCount, 0);
});

test("BrowserBridgeRuntime retries follower re-election until one peer wins and others reconnect", async () => {
  let disconnectLeader: (() => void) | undefined;
  let serverStartCount = 0;
  let remoteConnectCount = 0;
  let remoteRequestCount = 0;

  const runtime = new BrowserBridgeRuntime(
    () => {
      serverStartCount += 1;
      if (serverStartCount < 3) {
        return {
          async start() {
            throw createAddrInUseError();
          },
        } as unknown as BrowserBridgeServer;
      }
      return {
        async start() {
          // a different peer already won the election
          throw createAddrInUseError();
        },
      } as unknown as BrowserBridgeServer;
    },
    () => {
      remoteConnectCount += 1;
      let connected = remoteConnectCount === 1;
      const client: RemoteBridgeClientLike = {
        get connected() {
          return connected;
        },
        async connect() {
          if (remoteConnectCount === 2) {
            throw new Error("leader not ready");
          }
          connected = true;
        },
        async request(tool: BrowserToolName) {
          remoteRequestCount += 1;
          return { ok: true, via: remoteConnectCount === 1 ? "old-leader" : "new-leader", tool };
        },
        close() {
          connected = false;
        },
        setDisconnectHandler(handler: () => void) {
          if (remoteConnectCount === 1) {
            disconnectLeader = () => {
              connected = false;
              handler();
            };
          }
        },
      };
      return client;
    },
    "peer-test-id",
    0,
  );

  await runtime.ensureStarted();
  assert.equal(runtime.getStatus().role, "follower");

  disconnectLeader?.();
  await runtime.ensureStarted();

  const status = runtime.getStatus();
  assert.equal(status.role, "follower");
  assert.equal(remoteConnectCount, 3);

  const result = await runtime.call<{ ok: boolean; via: string }>("browser_tabs", { action: "list" });
  assert.deepEqual(result, { ok: true, via: "new-leader", tool: "browser_tabs" });
  assert.equal(remoteRequestCount, 1);
});
