#!/usr/bin/env node
// Frame-time harness for the WebGL2 3D memory graph (#62).
//
// Drives the real app in a headless Chrome over the DevTools protocol (no test-only
// dependencies): /demo-workspace → Memory → 3D → synthetic demo graph at 2k/10k/50k →
// rotate + zoom + hover, recording rAF frame times, main-thread long tasks and pick
// latency. Default Chrome flags select SwiftShader software GL so the harness runs on
// any machine; set CHROME_GPU_FLAGS="" to measure real hardware, and name the hardware
// (and this flag choice) when reporting results.
//
// Usage:
//   npm run dev:web                        # in another shell (or point BASE_URL at it)
//   node scripts/benchmark-memory-3d.mjs
//
// Env: BASE_URL (default http://127.0.0.1:4911), SIZES (default 2000,10000,50000),
// DURATION_MS (default 8000), CHROME_BIN, CHROME_GPU_FLAGS (default SwiftShader flags),
// RESULTS_FILE, SCREENSHOT_DIR.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4911";
const SIZES = (process.env.SIZES ?? "2000,10000,50000").split(",").map(value => Number.parseInt(value, 10)).filter(Number.isSafeInteger);
const DURATION_MS = Number.parseInt(process.env.DURATION_MS ?? "8000", 10);
const CHROME_BIN = process.env.CHROME_BIN ?? "chromium-browser";
const GPU_FLAGS = process.env.CHROME_GPU_FLAGS === "" ? [] :
  (process.env.CHROME_GPU_FLAGS ?? "--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader").split(" ");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectDevTools(port, url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(entry => entry.type === "page" && entry.url.startsWith(BASE_URL));
      if (!page) throw new Error("no page target");
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let messageId = 0;
      const pending = new Map();
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
        socket.send(JSON.stringify({ id, method, params }));
      });
      return { socket, send };
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome DevTools endpoint never became reachable.");
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "spaceapp-memory3d-bench-"));
  const child = spawn(CHROME_BIN, [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
    ...GPU_FLAGS, `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const debugPort = await new Promise((resolve, reject) => {
    child.stderr.on("data", chunk => {
      const match = String(chunk).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number.parseInt(match[1], 10));
    });
    child.on("exit", () => reject(new Error("Chrome exited immediately — check CHROME_BIN.")));
    setTimeout(() => reject(new Error("Chrome DevTools port timeout.")), 30000).unref();
  });
  try {
    const devtools = await connectDevTools(debugPort, `${BASE_URL}/demo-workspace`);
    await devtools.send("Page.enable");
    await devtools.send("Runtime.enable");
    const evaluate = async expression => {
      const outcome = await devtools.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression });
      if (outcome.result?.subtype === "error" || outcome.result?.exceptionDetails) {
        throw new Error(`page evaluation failed: ${JSON.stringify(outcome.result.exceptionDetails ?? outcome.result).slice(0, 400)}`);
      }
      return outcome.result?.value;
    };
    const waitForDom = async (expression, timeoutMs, label) => {
      const started = Date.now();
      for (;;) {
        if (await evaluate(expression)) return;
        if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(500);
      }
    };
    const results = [];
    for (const size of SIZES) {
      console.error(`\n=== benchmarking ${size.toLocaleString()} nodes (${DURATION_MS}ms rotate + zoom + hover) ===`);
      await devtools.send("Page.navigate", { url: `${BASE_URL}/demo-workspace` });
      await sleep(6000);
      await evaluate(`(() => {
        const workspaceMenu = document.querySelector('[aria-label="Workspace"]') || [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Workspace");
        workspaceMenu?.click();
        return "ok";
      })()`);
      await sleep(800);
      await evaluate(`(() => {
        const search = document.querySelector('input[aria-label="Find an action"]');
        if (search) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(search, "memory");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return "ok";
      })()`);
      await sleep(600);
      const opened = await evaluate(`(() => {
        const opener = document.querySelector('[aria-label="Open memory workspace"]');
        if (!opener) return "missing";
        opener.click();
        return "opened";
      })()`);
      if (opened !== "opened") throw new Error("Open memory workspace control not found (searched the workspace menu).");
      console.error("memory workspace opened");
      await waitForDom(`[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Atlas")`, 30000, "Atlas mode pill");
      await evaluate(`(() => { [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Atlas").click(); return "ok"; })()`);
      await waitForDom(`Boolean(document.querySelector('[aria-label="Toggle 3D memory view"]'))`, 30000, "3D toggle");
      await evaluate(`(() => { document.querySelector('[aria-label="Toggle 3D memory view"]').click(); return "ok"; })()`);
      console.error("3D view enabled");
      await waitForDom(`Boolean(document.querySelector('[aria-label="Load ${size} node demo graph"]'))`, 30000, "size preset button");
      await evaluate(`(() => { document.querySelector('[aria-label="Load ${size} node demo graph"]').click(); return "ok"; })()`);
      console.error(`synthetic ${size} node graph requested; waiting for layout…`);
      let lastReport = Date.now();
      await waitForDom(`document.getElementById("memory-atlas")?.dataset.layoutReady === "true" && document.querySelector(".memory-3d-surface canvas:not(.memory-3d-webgl)")?.getAttribute("aria-busy") === "false"`,
        Math.max(DURATION_MS * 2 + 300000, 320000), "layout completion");
      console.error("layout complete; measuring…");
      await sleep(2500);
      const measurement = `(async () => {
        window.__memory3dLongTasks = [];
        try {
          new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__memory3dLongTasks.push({ duration: Math.round(entry.duration), start: Math.round(entry.startTime) }); }).observe({ entryTypes: ["longtask"] });
        } catch {}
        const canvas = document.querySelector(".memory-3d-surface canvas:not(.memory-3d-webgl)");
        if (!canvas) throw new Error("3D canvas not mounted");
        const rects = canvas.getBoundingClientRect();
        const samples = [];
        let lastFrame = performance.now();
        let raf = 0;
        const totalMs = ${DURATION_MS} * 2 + 2500;
        const frames = new Promise(resolve => {
          const startedAt = performance.now();
          const tick = now => {
            samples.push(now - lastFrame);
            lastFrame = now;
            if (now - startedAt < totalMs) raf = requestAnimationFrame(tick); else resolve();
          };
          raf = requestAnimationFrame(tick);
        });
        const rotateStart = performance.now();
        while (performance.now() - rotateStart < ${DURATION_MS}) {
          canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
          canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
          await new Promise(r => setTimeout(r, 16));
        }
        ${process.env.DEBUG_STAGE === "rotate" ? `return { stage: "rotate-done", rotation: canvas.dataset.rotation, samples: samples.length };` : ""}
        const zoomStart = performance.now();
        let zoomDirection = 1;
        while (performance.now() - zoomStart < ${DURATION_MS}) {
          canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 90 * zoomDirection, clientX: rects.left + rects.width / 2, clientY: rects.top + rects.height / 2, cancelable: true }));
          if (Math.random() < 0.06) zoomDirection *= -1;
          await new Promise(r => setTimeout(r, 16));
        }
        ${process.env.DEBUG_STAGE === "zoom" ? `return { stage: "zoom-done", zoomSamples: samples.length };` : ""}
        const pickTimes = [];
        const hoverStart = performance.now();
        while (performance.now() - hoverStart < 2500) {
          canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: rects.left + Math.random() * rects.width, clientY: rects.top + Math.random() * rects.height, bubbles: true }));
          await new Promise(r => setTimeout(r, 33));
          if (canvas.dataset.pickMs) pickTimes.push(Number(canvas.dataset.pickMs));
        }
        cancelAnimationFrame(raf);
        ${process.env.DEBUG_STAGE === "hover" ? `return { stage: "hover-done", pickSamples: pickTimes.length, totalSamples: samples.length, longTasks: (window.__memory3dLongTasks ?? []).filter(entry => entry.duration > 100).length };` : ""}
        await frames;
        const deltas = samples.slice(1);
        const percentile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] * 100) / 100; };
        return {
          nodes: ${size},
          renderer: canvas.dataset.renderer,
          webgl2: (() => { try { return Boolean(document.querySelector(".memory-3d-webgl").getContext("webgl2")); } catch { return false; } })(),
          visibleNodes: Number(document.getElementById("memory-atlas")?.dataset.visibleNodeCount ?? -1),
          visibleEdges: Number(document.getElementById("memory-atlas")?.dataset.visibleEdgeCount ?? -1),
          rotation: canvas.dataset.rotation,
          layoutVolume: canvas.dataset.layoutVolume,
          frameP50: percentile(deltas, 0.5), frameP95: percentile(deltas, 0.95), frameMax: Math.round(Math.max(...deltas) * 100) / 100,
          samples: deltas.length,
          longTasksOver100ms: (window.__memory3dLongTasks ?? []).filter(entry => entry.duration > 100),
          pickP95: percentile(pickTimes, 0.95), pickMax: pickTimes.length ? Math.round(Math.max(...pickTimes) * 100) / 100 : null, pickSamples: pickTimes.length
        };
      })()`;
      const result = await evaluate(measurement);
      if (process.env.DEBUG_STAGE) { console.log("PARTIAL", JSON.stringify(result)); continue; }
      if (!result || !result.renderer) throw new Error(`measurement incomplete: ${JSON.stringify(result).slice(0, 300)}`);
      results.push(result);
      console.log(JSON.stringify(result));
      const screenshot = await devtools.send("Page.captureScreenshot", { format: "png" });
      const screenshotPath = process.env.SCREENSHOT_DIR ?? join(tmpdir(), `memory3d-${size}.png`);
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      console.error(`screenshot: ${screenshotPath}`);
    }
    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify(results, null, 2));
    writeFileSync(process.env.RESULTS_FILE ?? "benchmark-memory-3d-results.json", JSON.stringify(results, null, 2));
  } finally {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
