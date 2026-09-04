import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const workDir = resolve(rootDir, "dist/.browser-bridge-cli-sea");
const distDir = resolve(rootDir, "dist");
const bundlePath = resolve(workDir, "browser-bridge-cli.cjs");
const seaConfigPath = resolve(workDir, "sea-config.json");
const seaBlobPath = resolve(workDir, "browser-bridge-cli.blob");
const outputPath = resolve(distDir, "browser-bridge-cli");
const postjectCliPath = resolve(rootDir, "node_modules/postject/dist/cli.js");

const SEA_BLOB_RESOURCE_NAME = "NODE_SEA_BLOB";
const SEA_MACHO_SEGMENT_NAME = "NODE_SEA";
const NODE_SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

async function main() {
  if (process.platform !== "darwin") {
    throw new Error(`This local packager currently supports macOS only; got ${process.platform}`);
  }

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(distDir, { recursive: true });

  await buildBundle();
  await writeSeaConfig();
  await run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
  await copyNodeBinary();
  await removeSignature(outputPath);
  await injectSeaBlob();
  await signBinary(outputPath);
  await verifyBinary(outputPath);

  process.stdout.write(`${outputPath}\n`);
}

async function buildBundle() {
  await build({
    entryPoints: [resolve(rootDir, "cli/browser-bridge-cli.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
  });

  const bundle = await readFile(bundlePath, "utf8");
  const sanitized = bundle.replace(/^#!.*\n/, "");
  if (sanitized !== bundle) {
    await writeFile(bundlePath, sanitized, "utf8");
  }
}

async function writeSeaConfig() {
  const config = {
    main: bundlePath,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  };
  await writeFile(seaConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function copyNodeBinary() {
  if (process.platform === "darwin") {
    try {
      await run("lipo", ["-thin", process.arch, process.execPath, "-output", outputPath]);
      await chmod(outputPath, 0o755);
      return;
    } catch {
      // fallback to plain copy for non-universal binaries
    }
  }
  await copyFile(process.execPath, outputPath);
  await chmod(outputPath, 0o755);
}

async function injectSeaBlob() {
  await run(process.execPath, [
    postjectCliPath,
    outputPath,
    SEA_BLOB_RESOURCE_NAME,
    seaBlobPath,
    "--sentinel-fuse",
    NODE_SEA_FUSE,
    "--macho-segment-name",
    SEA_MACHO_SEGMENT_NAME,
  ]);
}

async function verifyBinary(binaryPath) {
  const { stdout, stderr, code } = await run(binaryPath, ["--help"], { allowFailure: true });
  const combined = `${stdout}${stderr}`;
  if (code !== 0 && code !== 2) {
    throw new Error(`Built binary failed verification with exit code ${code}: ${combined}`);
  }
  if (!combined.includes("browser-bridge-cli <tool>")) {
    throw new Error(`Built binary did not print usage as expected: ${combined}`);
  }
}

async function removeSignature(binaryPath) {
  await run("codesign", ["--remove-signature", binaryPath], { allowFailure: true });
}

async function signBinary(binaryPath) {
  await run("codesign", ["--sign", "-", binaryPath]);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${result.code}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
