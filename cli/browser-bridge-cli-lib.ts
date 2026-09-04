import type { BrowserToolName } from "../pi-extension/shared/browser-types";

const CLI_TOOL_TO_BRIDGE_TOOL = {
  tabs: "browser_tabs",
  capture: "browser_capture",
  filter: "browser_filter",
  snapshot: "browser_snapshot",
  act: "browser_act",
  script: "browser_script",
  fetch: "browser_fetch",
  navigate: "browser_navigate",
} satisfies Record<string, BrowserToolName>;

type CliToolName = keyof typeof CLI_TOOL_TO_BRIDGE_TOOL;

interface ParsedFlags {
  booleans: Set<string>;
  values: Map<string, string[]>;
}

export interface BrowserBridgeCliToolCommand {
  kind: "tool";
  cliTool: CliToolName;
  tool: BrowserToolName;
  payload: Record<string, unknown>;
  text: boolean;
  file?: string;
}

export interface BrowserBridgeCliServeCommand {
  kind: "serve";
}

export type BrowserBridgeCliCommand = BrowserBridgeCliToolCommand | BrowserBridgeCliServeCommand;

export interface CliRenderOutput {
  kind: "text" | "buffer";
  value: string | Buffer;
}

export class CliUsageError extends Error {}

export function parseCliArgs(argv: string[]): BrowserBridgeCliCommand {
  if (argv.length === 0 || argv.includes("--help")) {
    throw new CliUsageError(buildUsage());
  }

  const [toolArg, ...rest] = argv;
  if (toolArg === "serve") {
    if (rest.length !== 0) {
      throw new CliUsageError(`serve does not accept flags\n\n${buildUsage()}`);
    }
    return { kind: "serve" };
  }
  if (!(toolArg in CLI_TOOL_TO_BRIDGE_TOOL)) {
    throw new CliUsageError(`Unknown tool: ${toolArg}\n\n${buildUsage()}`);
  }

  const cliTool = toolArg as CliToolName;
  const tool = CLI_TOOL_TO_BRIDGE_TOOL[cliTool];
  const flags = scanFlags(rest);
  const text = flags.booleans.has("text");
  const file = optionalSingle(flags, "file");

  switch (tool) {
    case "browser_tabs":
      assertAllowedFlags(tool, flags, new Set(["action", "tab-id", "url", "text", "file"]));
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: compactObject({
          action: optionalSingle(flags, "action") ?? "list",
          tabID: optionalSingle(flags, "tab-id"),
          url: optionalSingle(flags, "url"),
        }),
      };
    case "browser_capture":
      assertAllowedFlags(tool, flags, new Set(["tab-id", "max-nodes", "text", "file"]));
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: compactObject({
          tabID: requiredSingle(flags, "tab-id"),
          maxNodes: optionalNumber(flags, "max-nodes"),
        }),
      };
    case "browser_filter":
      assertAllowedFlags(tool, flags, new Set(["tab-id", "selector", "max-nodes", "text", "file"]));
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: compactObject({
          tabID: requiredSingle(flags, "tab-id"),
          selector: requiredSingle(flags, "selector"),
          maxNodes: optionalNumber(flags, "max-nodes"),
        }),
      };
    case "browser_snapshot":
      assertAllowedFlags(tool, flags, new Set(["tab-id", "text", "file"]));
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: {
          tabID: requiredSingle(flags, "tab-id"),
        },
      };
    case "browser_act":
      assertAllowedFlags(
        tool,
        flags,
        new Set(["tab-id", "action", "selector", "value", "key", "scroll-delta-x", "scroll-delta-y", "target-selector", "text", "file"]),
      );
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: buildActPayload(flags),
      };
    case "browser_script":
      assertAllowedFlags(tool, flags, new Set(["tab-id", "script", "timeout", "text", "file"]));
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: compactObject({
          tabID: requiredSingle(flags, "tab-id"),
          script: requiredSingle(flags, "script"),
          timeout: optionalNumber(flags, "timeout"),
        }),
      };
    case "browser_fetch":
      assertAllowedFlags(
        tool,
        flags,
        new Set(["tab-id", "url", "method", "header", "payload", "response-type", "credentials", "text", "file"]),
      );
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: buildFetchPayload(flags),
      };
    case "browser_navigate":
      assertAllowedFlags(tool, flags, new Set(["tab-id", "action", "url", "text", "file"]));
      return {
        kind: "tool",
        cliTool,
        tool,
        text,
        file,
        payload: buildNavigatePayload(flags),
      };
  }
}

export function renderCliOutput(tool: BrowserToolName, payload: unknown, options: { text: boolean; forFile: boolean }): CliRenderOutput {
  if (options.forFile && isFetchBlobResult(payload)) {
    return {
      kind: "buffer",
      value: Buffer.from(payload.data, "base64"),
    };
  }

  if (options.text) {
    return {
      kind: "text",
      value: renderTextOutput(tool, payload),
    };
  }

  return {
    kind: "text",
    value: `${JSON.stringify(payload, null, 2)}\n`,
  };
}

export function buildUsage(): string {
  return [
    "Usage:",
    "browser-bridge-cli <tool> [tool flags] [--text] [--file <filename>]",
    "browser-bridge-cli serve",
    "",
    "Tools:",
    "serve",
    "tabs --action list|create|delete|activate [--tab-id <id>] [--url <url>]",
    "capture --tab-id <id> [--max-nodes <n>]",
    "filter --tab-id <id> --selector <css> [--max-nodes <n>]",
    "snapshot --tab-id <id>",
    "act --tab-id <id> --action <click|keydown|keyup|keypress|input|focus|scroll|drag> [--selector <css>] [--value <text>] [--key <key>] [--scroll-delta-x <v>] [--scroll-delta-y <v>] [--target-selector <css>]",
    "script --tab-id <id> --script '<js>' [--timeout <ms>]",
    "fetch --tab-id <id> --url <url> [--method <m>] [--header 'K=V'] [--payload <body>] [--response-type text|blob] [--credentials omit|same-origin|include]",
    "navigate --tab-id <id> --action goto|reload|back|forward [--url <url>]",
    "",
    "Output:",
    "--text                Print raw text/HTML for capture/filter/snapshot/fetch-text; otherwise pretty JSON.",
    "--file <filename>     Save result to file. Fetch blob writes binary bytes; --text preserves full text without truncation.",
  ].join("\n");
}

function scanFlags(argv: string[]): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new CliUsageError(`Unexpected positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (name === "text") {
      booleans.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new CliUsageError(`Missing value for --${name}`);
    }
    const bucket = values.get(name) ?? [];
    bucket.push(next);
    values.set(name, bucket);
    index += 1;
  }

  return { booleans, values };
}

function buildActPayload(flags: ParsedFlags): Record<string, unknown> {
  const action = requiredSingle(flags, "action");
  const payload = compactObject({
    tabID: requiredSingle(flags, "tab-id"),
    action,
    selector: optionalSingle(flags, "selector"),
    value: optionalSingle(flags, "value"),
    keys: optionalMany(flags, "key"),
    scrollDeltaX: optionalScrollDelta(flags, "scroll-delta-x"),
    scrollDeltaY: optionalScrollDelta(flags, "scroll-delta-y"),
    targetSelector: optionalSingle(flags, "target-selector"),
  });

  if (action === "scroll") {
    if (payload.scrollDeltaX === undefined && payload.scrollDeltaY === undefined) {
      throw new CliUsageError("act --action scroll requires --scroll-delta-x or --scroll-delta-y");
    }
    return payload;
  }

  if (typeof payload.selector !== "string") {
    throw new CliUsageError(`act --action ${action} requires --selector`);
  }
  if (action === "drag" && typeof payload.targetSelector !== "string") {
    throw new CliUsageError("act --action drag requires --target-selector");
  }
  return payload;
}

function buildFetchPayload(flags: ParsedFlags): Record<string, unknown> {
  const headers = optionalMany(flags, "header")?.reduce<Record<string, string>>((acc, raw) => {
    const index = raw.indexOf("=");
    if (index <= 0) {
      throw new CliUsageError(`Invalid --header value: ${raw}`);
    }
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1);
    if (!key) {
      throw new CliUsageError(`Invalid --header value: ${raw}`);
    }
    acc[key] = value;
    return acc;
  }, {});

  const body = compactObject({
    method: optionalSingle(flags, "method"),
    headers: headers && Object.keys(headers).length ? headers : undefined,
    payload: optionalSingle(flags, "payload"),
    responseType: optionalSingle(flags, "response-type"),
    credentials: optionalSingle(flags, "credentials"),
  });

  return compactObject({
    tabID: requiredSingle(flags, "tab-id"),
    url: requiredSingle(flags, "url"),
    body: Object.keys(body).length ? body : undefined,
  });
}

function buildNavigatePayload(flags: ParsedFlags): Record<string, unknown> {
  const action = requiredSingle(flags, "action");
  const url = optionalSingle(flags, "url");
  if (action === "goto" && !url) {
    throw new CliUsageError("navigate --action goto requires --url");
  }
  return compactObject({
    tabID: requiredSingle(flags, "tab-id"),
    action,
    url,
  });
}

function renderTextOutput(tool: BrowserToolName, payload: unknown): string {
  if (tool === "browser_capture" || tool === "browser_filter" || tool === "browser_snapshot") {
    const html = (payload as { html?: unknown })?.html;
    if (typeof html === "string") {
      return html;
    }
  }

  if (tool === "browser_fetch") {
    if (isFetchTextResult(payload)) {
      return payload.data;
    }
    if (isFetchBlobResult(payload)) {
      return payload.data;
    }
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function optionalSingle(flags: ParsedFlags, name: string): string | undefined {
  const values = flags.values.get(name);
  if (!values || values.length === 0) {
    return undefined;
  }
  if (values.length > 1) {
    throw new CliUsageError(`--${name} may only be specified once`);
  }
  return values[0];
}

function requiredSingle(flags: ParsedFlags, name: string): string {
  const value = optionalSingle(flags, name);
  if (!value) {
    throw new CliUsageError(`Missing required --${name}`);
  }
  return value;
}

function optionalMany(flags: ParsedFlags, name: string): string[] | undefined {
  const values = flags.values.get(name);
  return values && values.length ? values : undefined;
}

function optionalNumber(flags: ParsedFlags, name: string): number | undefined {
  const value = optionalSingle(flags, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`--${name} must be a number`);
  }
  return parsed;
}

function optionalScrollDelta(flags: ParsedFlags, name: string): number | string | undefined {
  const value = optionalSingle(flags, name);
  if (value === undefined) {
    return undefined;
  }
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function assertAllowedFlags(tool: BrowserToolName, flags: ParsedFlags, allowed: Set<string>): void {
  for (const name of flags.booleans) {
    if (!allowed.has(name)) {
      throw new CliUsageError(`Unsupported flag for ${tool}: --${name}`);
    }
  }
  for (const name of flags.values.keys()) {
    if (!allowed.has(name)) {
      throw new CliUsageError(`Unsupported flag for ${tool}: --${name}`);
    }
  }
}

function isFetchTextResult(payload: unknown): payload is { ok: true; data: string } {
  return Boolean(payload && typeof payload === "object" && "ok" in payload && "data" in payload && typeof (payload as { data?: unknown }).data === "string" && !("encoding" in payload));
}

function isFetchBlobResult(payload: unknown): payload is { ok: true; data: string; encoding: "base64" } {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "ok" in payload &&
      "data" in payload &&
      typeof (payload as { data?: unknown }).data === "string" &&
      (payload as { encoding?: unknown }).encoding === "base64",
  );
}
