import test from "node:test";
import assert from "node:assert/strict";
import { createMessage, parseBridgeMessage } from "../pi-extension/shared/protocol";

test("createMessage fills id and ts", () => {
  const message = createMessage({
    kind: "request",
    source: "pi",
    tool: "browser_tabs",
    payload: {},
  });

  assert.equal(typeof message.id, "string");
  assert.equal(typeof message.ts, "number");
  assert.equal(message.kind, "request");
});

test("parseBridgeMessage reads serialized envelope", () => {
  const raw = JSON.stringify(
    createMessage({
      kind: "response",
      source: "chrome-sw",
      replyTo: "req-1",
      tool: "browser_tabs",
      payload: [{ tabID: "1", active: true }],
    }),
  );

  const parsed = parseBridgeMessage(raw);
  assert.equal(parsed.replyTo, "req-1");
  assert.equal(parsed.kind, "response");
});
