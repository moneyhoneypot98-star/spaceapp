#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// Issue #64 (per-service images) gave every image its own production
// dependency closure via scripts/prune-container-targets.mjs, and the
// runtime-base stage no longer copies the whole monorepo output into every
// image. Foreign-platform native artifacts are dropped per TARGETARCH
// (@temporalio/core-bridge releases, node-pty prebuilds, @napi-rs/canvas
// platform packages). The cli stage also drops the unused @opencode/cli
// platform binaries in its install layer. Measured with
// scripts/container-image-size-budget.mjs in the Container matrix run on both
// architectures (2026-10-22, 1.1.7; was = upstream main 1.1.7):
//   core:    702.9 MiB linux/amd64, 733.2 MiB linux/arm64 (was 1057.6 / 1079.8)
//   browser: 1196.7 MiB linux/amd64, 1221.4 MiB linux/arm64 (was 1732.8 / 1747.9; with xvfb)
//   cli:      637.3 MiB linux/amd64, 669.0 MiB linux/arm64 (was 1889.3 / 1496.9)
// 1.1.8 (resync) added python3 (not python3-minimal) to the core stage for the Databases
// tool's SQLite worker; upstream measured that addition at +32.7 MiB on their un-pruned
// core image (1057.9 -> 1090.6 MiB amd64, see upstream's own history below). Applied to our
// pruned core baseline that is an estimated ~735.6 MiB amd64 / ~765.9 MiB arm64 - still under
// this budget, but NOT independently remeasured on the merged tree. Re-run the Container
// matrix before relying on this margin.
export const containerImageSizeBudgets = Object.freeze({
  core: 800 * mebibyte,
  browser: 1280 * mebibyte,
  cli: 850 * mebibyte
});
// Upstream's own core budget history, kept for context since our per-service budget above
// supersedes it for this fork's images:
// 1.1.3 raised core and browser (998.7 / 1670.6 MiB measured): the current
// application adds production dependencies pdfjs-dist with @napi-rs/canvas
// (81 MiB, API PDF handling), typescript (23 MiB, peer of @t3-oss/env-core) and
// js-tiktoken (22 MiB, Space Gateway token counting).
// 1.1.5 raised core again: linux/arm64 measured 1066.9 MiB and linux/amd64 1045.0 MiB (sqlite3 in the image,
// the 1.1.5 application); the first public release run failed the arm64 build at 1050 MiB.
// 1.1.8 raised core to 1150 MiB for Python with sqlite3 (the Databases tool's SQLite worker): linux/amd64 measured
// 1090.6 MiB with python3 (rc3 without Python: 1057.9 MiB); the trimmed python3-minimal + libpython3-stdlib variant
// measured 1078.6 MiB, 21.4 MiB under the old 1100 MiB, and arm64 ran about 22 MiB above amd64 in 1.1.5.

export function evaluateContainerImageSize({ target, sizeBytes }) {
  const budgetBytes = containerImageSizeBudgets[target];
  if (budgetBytes === undefined) {
    throw new Error(`Unknown container target: ${target}`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid container image size: ${sizeBytes}`);
  }

  const remainingBytes = budgetBytes - sizeBytes;
  return {
    target,
    sizeBytes,
    budgetBytes,
    remainingBytes,
    ok: remainingBytes >= 0
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

export function inspectContainerImageSize(image) {
  const output = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
  return Number(output);
}

export function runContainerImageSizeBudget(args = process.argv.slice(2)) {
  const target = optionValue(args, "--target");
  const image = optionValue(args, "--image");
  if (!target || !image) {
    throw new Error(
      "Usage: container-image-size-budget.mjs --target <core|browser|cli> --image <name:tag>"
    );
  }

  const result = evaluateContainerImageSize({
    target,
    sizeBytes: inspectContainerImageSize(image)
  });
  const summary = [
    `${result.target} image ${image}: ${formatMebibytes(result.sizeBytes)}`,
    `budget ${formatMebibytes(result.budgetBytes)}`,
    `remaining ${formatMebibytes(result.remainingBytes)}`
  ].join("; ");
  if (!result.ok) {
    throw new Error(`Container image size budget exceeded: ${summary}`);
  }
  process.stdout.write(`${summary}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runContainerImageSizeBudget();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
