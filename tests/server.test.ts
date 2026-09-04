import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { BrowserBridgeServer } from "../pi-extension/server";

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("BrowserBridgeServer.start rejects on EADDRINUSE", async () => {
  const occupied = createServer();
  await listen(occupied, 0, "127.0.0.1");

  try {
    const address = occupied.address();
    assert.ok(address && typeof address === "object");

    const bridge = new BrowserBridgeServer("127.0.0.1", address.port, "/agent");
    await assert.rejects(
      () => bridge.start(),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
  } finally {
    await close(occupied);
  }
});
