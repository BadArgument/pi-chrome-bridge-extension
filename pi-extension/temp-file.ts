import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRootPromise = mkdtemp(path.join(os.tmpdir(), "pi-browser-bridge-"));

export async function writeTempTextFile(content: string, extension = ".txt"): Promise<string> {
  const dir = await tempRootPromise;
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

export async function writeTempBufferFile(content: Uint8Array, extension = ".bin"): Promise<string> {
  const dir = await tempRootPromise;
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  await writeFile(filePath, content);
  return filePath;
}
