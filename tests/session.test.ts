import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BridgeSessionManager } from "../pi-extension/session";
import { createMessage } from "../pi-extension/shared/protocol";

class FakeSocket extends EventEmitter {
  closed = false;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }
}

test("BridgeSessionManager treats hello role=chrome as chrome client", () => {
  const sessions = new BridgeSessionManager();
  const socket = new FakeSocket();
  sessions.attach(socket as never);

  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify(
        createMessage({
          kind: "hello",
          source: "chrome-sw",
          payload: {
            role: "chrome",
            extensionVersion: "1.0.0",
            wsUrl: "ws://127.0.0.1:29180/agent",
            heartbeatMs: 2500,
            tabsSummary: {
              total: 1,
              injectable: 1,
              executorReady: 1,
              restricted: 0,
            },
          },
        }),
      ),
    ),
  );

  const status = sessions.status();
  assert.equal(status.connected, true);
  assert.equal(status.ready, true);
  assert.equal(status.clientInfo?.role, "chrome");
  assert.equal(status.peerCount, 0);
});

test("BridgeSessionManager treats hello role=peer as peer client", () => {
  const sessions = new BridgeSessionManager();
  const socket = new FakeSocket();
  sessions.attach(socket as never);

  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify(
        createMessage({
          kind: "hello",
          source: "pi",
          payload: {
            role: "peer",
            peerId: "peer-1",
          },
        }),
      ),
    ),
  );

  const status = sessions.status();
  assert.equal(status.connected, false);
  assert.equal(status.ready, false);
  assert.equal(status.peerCount, 1);
});

test("BridgeSessionManager rejects hello without role", () => {
  const sessions = new BridgeSessionManager();
  const socket = new FakeSocket();
  sessions.attach(socket as never);

  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify(
        createMessage({
          kind: "hello",
          source: "chrome-sw",
          payload: {
            extensionVersion: "1.0.0",
            wsUrl: "ws://127.0.0.1:29180/agent",
            heartbeatMs: 2500,
            tabsSummary: {
              total: 1,
              injectable: 1,
              executorReady: 1,
              restricted: 0,
            },
          },
        }),
      ),
    ),
  );

  assert.equal(socket.closed, true);
  assert.equal(sessions.status().connected, false);
  assert.equal(sessions.status().peerCount, 0);
});
