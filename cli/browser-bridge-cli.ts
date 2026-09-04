#!/usr/bin/env -S node --import tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { parseCliArgs, renderCliOutput, CliUsageError } from "./browser-bridge-cli-lib";
import { BrowserBridgeRuntime } from "../pi-extension/runtime";

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));
  const runtime = new BrowserBridgeRuntime();

  if (command.kind === "serve") {
    await runtime.ensureStarted({ leaderOnly: true });
    if (runtime.getStatus().role !== "leader") {
      await runtime.stop();
      return;
    }
    try {
      await waitForShutdownSignal();
    } finally {
      await runtime.stop();
    }
    return;
  }

  await runtime.ensureStarted();

  try {
    const payload = await runtime.call(command.tool, command.payload);
    const rendered = renderCliOutput(command.tool, payload, {
      text: command.text,
      forFile: Boolean(command.file),
    });

    if (command.file) {
      const outputPath = resolve(command.file);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeOutput(outputPath, rendered);
      stdout.write(`${outputPath}\n`);
      return;
    }

    stdout.write(typeof rendered.value === "string" ? ensureTrailingNewline(rendered.value) : `${Buffer.from(rendered.value).toString("base64")}\n`);
  } finally {
    await runtime.stop();
  }
}

async function writeOutput(file: string, rendered: ReturnType<typeof renderCliOutput>): Promise<void> {
  if (rendered.kind === "buffer") {
    await writeFile(file, rendered.value as Buffer);
    return;
  }
  await writeFile(file, rendered.value as string, "utf8");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const onSignal = () => {
      for (const signal of signals) {
        process.off(signal, onSignal);
      }
      resolve();
    };
    for (const signal of signals) {
      process.on(signal, onSignal);
    }
  });
}

main().catch((error) => {
  if (error instanceof CliUsageError) {
    stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
