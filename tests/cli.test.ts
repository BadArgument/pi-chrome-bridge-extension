import test from "node:test";
import assert from "node:assert/strict";
import { buildUsage, parseCliArgs, renderCliOutput } from "../cli/browser-bridge-cli-lib";

test("parseCliArgs parses serve command", () => {
  const command = parseCliArgs(["serve"]);

  assert.deepEqual(command, { kind: "serve" });
});

test("parseCliArgs parses browser_act scroll flags", () => {
  const command = parseCliArgs([
    "act",
    "--tab-id",
    "42",
    "--action",
    "scroll",
    "--scroll-delta-y",
    "30vh",
    "--scroll-delta-x",
    "120",
  ]);

  assert.equal(command.kind, "tool");
  assert.equal(command.cliTool, "act");
  assert.equal(command.tool, "browser_act");
  assert.equal(command.text, false);
  assert.deepEqual(command.payload, {
    tabID: "42",
    action: "scroll",
    scrollDeltaY: "30vh",
    scrollDeltaX: 120,
  });
});

test("parseCliArgs parses browser_fetch headers and output flags", () => {
  const command = parseCliArgs([
    "fetch",
    "--tab-id",
    "9",
    "--url",
    "/api",
    "--method",
    "POST",
    "--header",
    "Content-Type=application/json",
    "--header",
    "X-Test=1",
    "--payload",
    "{}",
    "--response-type",
    "text",
    "--credentials",
    "same-origin",
    "--text",
    "--file",
    "out.txt",
  ]);

  assert.equal(command.kind, "tool");
  assert.equal(command.cliTool, "fetch");
  assert.equal(command.tool, "browser_fetch");
  assert.equal(command.text, true);
  assert.equal(command.file, "out.txt");
  assert.deepEqual(command.payload, {
    tabID: "9",
    url: "/api",
    body: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test": "1",
      },
      payload: "{}",
      responseType: "text",
      credentials: "same-origin",
    },
  });
});

test("renderCliOutput returns full html for capture text mode without truncation", () => {
  const html = `<div>${"x".repeat(40000)}</div>`;
  const rendered = renderCliOutput("browser_capture", { html, totalNodes: 1, rootCount: 1 }, { text: true, forFile: false });

  assert.equal(rendered.kind, "text");
  assert.equal(rendered.value, html);
});

test("renderCliOutput decodes fetch blob for file output", () => {
  const rendered = renderCliOutput(
    "browser_fetch",
    {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      mimeType: "application/octet-stream",
      size: 3,
      data: Buffer.from("abc").toString("base64"),
      encoding: "base64",
    },
    { text: false, forFile: true },
  );

  assert.equal(rendered.kind, "buffer");
  assert.deepEqual(rendered.value, Buffer.from("abc"));
});

test("buildUsage mentions serve, text and file output", () => {
  const usage = buildUsage();
  assert.match(usage, /browser-bridge-cli serve/);
  assert.match(usage, /^serve$/m);
  assert.match(usage, /--text/);
  assert.match(usage, /--file <filename>/);
});
