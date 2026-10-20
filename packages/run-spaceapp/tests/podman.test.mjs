import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { run } from "../src/cli.mjs";
import {
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  loadConfig,
  renderPodmanCompose,
  renderWorkspaceCompose,
  saveConfig,
  validateConfig,
  PODMAN_USERNS_SERVICES,
  PODMAN_USERNS_MODE
} from "../src/index.mjs";
import {
  ensurePodmanAvailable,
  parsePodmanVersion,
  podmanComposeProviderFacts,
  versionAtLeast
} from "../src/prerequisites.mjs";

const PODMAN_VERSION_OUTPUT = "podman version 5.2.1";

function io() {
  let output = "";
  const stream = new Writable({ write(c, _e, done) { output += c; done(); } });
  return { stream, text: () => output };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = io();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: out.stream,
    prepareDockerPath: async () => {},
    ensureDocker: async () => ({ code: 0 }),
    inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 }),
    execute: async (spec) => { calls.push(spec); return 0; },
    sleep: async () => {},
    request: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null } })
  };
  return { root, out, calls, options };
}

test("compose defaults to Docker and is byte-compatible with the previous behavior", () => {
  const spec = composeCommand("up", tmpdir(), { profile: "small" });
  assert.equal(spec.command, "docker");
  assert.ok(!spec.args.some((arg) => String(arg).includes("compose.podman.yml")));
  const backup = composeCommand("backup", tmpdir(), { profile: "small" });
  assert.deepEqual(backup.args.slice(-7), ["exec", "-T", "--user", "0:0", "spaceapp-core", "node", "scripts/portable-backup.mjs"]);
});

test("--engine podman drives podman compose with the podman override file", () => {
  const up = composeCommand("up", tmpdir(), { profile: "small", engine: "podman" });
  assert.equal(up.command, "podman");
  const podmanIndex = up.args.indexOf(join(tmpdir(), "compose.podman.yml"));
  assert.ok(podmanIndex > 0, "the podman override file is included");
  assert.equal(up.args[podmanIndex - 1], "-f");
  const hostAccessIndex = up.args.indexOf(join(tmpdir(), "compose.host-access.yml"));
  assert.ok(podmanIndex > hostAccessIndex, "podman overrides load after the host-access file");
  const backup = composeCommand("backup", tmpdir(), { profile: "small", engine: "podman" });
  assert.deepEqual(backup.args.slice(-7), ["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "scripts/portable-backup.mjs"]);
  const restore = composeCommand("restore", tmpdir(), { profile: "small", engine: "podman", backupId: "spaceapp-backup-20261020T000000000Z" });
  assert.ok(restore.args.includes("10001:10001"), "restore reaches the host-owned ./backups bind mount as the host user");
  assert.throws(() => composeCommand("up", tmpdir(), { profile: "small", engine: "nerdctl" }), /engine must be docker or podman/);
});

test("config accepts docker and podman engines and rejects unknown ones", () => {
  const config = createDefaultConfig({ version: "1.1.6" });
  assert.equal(config.engine, undefined, "fresh Docker installs keep the previous config shape");
  assert.equal(validateConfig({ ...config, engine: "podman" }).engine, "podman");
  assert.equal(validateConfig({ ...config, engine: "docker" }).engine, "docker");
  assert.throws(() => validateConfig({ ...config, engine: "nerdctl" }), /engine must be docker or podman/);
});

test("the podman override maps the host user to container uid 10001 for the data services only", () => {
  const config = validateConfig({ ...createDefaultConfig({ version: "1.1.6" }), engine: "podman", users: [{ id: "user:testuser", workspaces: [] }] });
  const rendered = renderPodmanCompose(config);
  for (const service of PODMAN_USERNS_SERVICES) {
    assert.match(rendered, new RegExp(`  ${service}:\\n    userns_mode: "${PODMAN_USERNS_MODE}"\\n    user: "0:0"`));
  }
  assert.match(rendered, /spaceapp-cli-testuser-/, "per-user CLI containers get the same mapping");
  assert.match(rendered, /spaceapp-cli-testuser[^:]*:\n    userns_mode: "keep-id:uid=10001,gid=10001"\n    user: "0:0"/, "per-user CLI containers start as container root so the entrypoint can gosu down");
  assert.ok(!/postgres:/.test(rendered), "postgres keeps Podman's default mapping");
  assert.ok(!/temporal:/.test(rendered), "temporal keeps Podman's default mapping");
});

test("workspace bind mounts get SELinux relabeling only under Podman", () => {
  const workspace = { id: "w-12345678", hostPath: "/tmp/w", containerPath: "/workspaces/w", readOnly: false };
  const dockerConfig = validateConfig({ ...createDefaultConfig({ version: "1.1.6" }), workspaces: [workspace] });
  assert.ok(!renderWorkspaceCompose(dockerConfig).includes("selinux"));
  const podmanConfig = validateConfig({ ...dockerConfig, engine: "podman" });
  assert.match(renderWorkspaceCompose(podmanConfig), /bind:\n          selinux: "z"/);
});

test("writeRuntimeFiles writes compose.podman.yml only for podman installs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeRuntimeFiles } = await import("../src/index.mjs");
  const dockerConfig = createDefaultConfig({ version: "1.1.6" });
  await writeRuntimeFiles(root, dockerConfig);
  await assert.rejects(() => readFile(join(root, "compose.podman.yml")), { code: "ENOENT" });
  await writeRuntimeFiles(root, { ...dockerConfig, engine: "podman" });
  const podmanFile = await readFile(join(root, "compose.podman.yml"), "utf8");
  assert.match(podmanFile, /userns_mode: "keep-id:uid=10001,gid=10001"\n    user: "0:0"/);
});

test("podman version parsing and provider facts", async () => {
  assert.equal(parsePodmanVersion(PODMAN_VERSION_OUTPUT), "5.2.1");
  assert.equal(parsePodmanVersion("podman version 4.9.3"), "4.9.3");
  assert.equal(parsePodmanVersion(""), null);
  assert.equal(versionAtLeast("5.0.0", "5.0.0"), true);
  assert.equal(versionAtLeast("4.9.3", "5.0.0"), false);
  assert.equal(versionAtLeast("5.1.2", "5.0.0"), true);
  const facts = await podmanComposeProviderFacts({ execute: async (spec, io) => { io.stdout?.write?.("Docker Compose version v2.32.4"); return 0; } });
  assert.equal(facts.available, true);
  assert.equal(facts.name, "docker-compose");
});

async function podmanExecute(calls, { version = PODMAN_VERSION_OUTPUT, info = true, compose = "Docker Compose version v2.32.4" } = {}) {
  return async (spec, ioo) => {
    calls.push(spec);
    if (spec.command === "podman" && spec.args[0] === "--version") { ioo.stdout?.write?.(version); return 0; }
    if (spec.command === "podman" && spec.args[0] === "info") return info ? 0 : 1;
    if (spec.command === "podman" && spec.args[0] === "compose") { ioo.stdout?.write?.(compose); return compose ? 0 : 1; }
    return 0;
  };
}

test("ensurePodmanAvailable refuses Windows and missing/too-old podman", async (t) => {
  const stderr = io();
  const winResult = await ensurePodmanAvailable({ platform: "win32", stderr: stderr.stream, execute: await podmanExecute([]) });
  assert.equal(winResult.code, 1);
  const missing = io();
  const missingResult = await ensurePodmanAvailable({ platform: "linux", stderr: missing.stream, execute: async () => 127 });
  assert.equal(missingResult.code, 1);
  assert.match(missing.text(), /apt-get install podman|dnf install podman/);
  const oldCalls = [];
  const oldStderr = io();
  const oldResult = await ensurePodmanAvailable({ platform: "linux", stderr: oldStderr.stream, execute: await podmanExecute(oldCalls, { version: "podman version 4.8.2" }) });
  assert.equal(oldResult.code, 1);
  assert.match(oldStderr.text(), /too old/);
});

test("ensurePodmanAvailable succeeds with a reachable provider and socket", async (t) => {
  const calls = [];
  const runtimeDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-socket-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const stderr = io();
  const stdout = io();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: await podmanExecute(calls),
    sleep: async () => {},
    launch: async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(runtimeDir, "podman"), { recursive: true });
      await writeFile(join(runtimeDir, "podman", "podman.sock"), "");
      return 0;
    }
  });
  delete process.env.XDG_RUNTIME_DIR;
  assert.equal(result.code, 0);
  assert.match(stdout.text(), /Podman 5\.2\.1 is ready/);
  const noProvider = io();
  const noProviderResult = await ensurePodmanAvailable({
    platform: "linux",
    stderr: noProvider.stream,
    execute: await podmanExecute([], { compose: "" }),
    sleep: async () => {},
    launch: async () => 1
  });
  assert.equal(noProviderResult.code, 1);
  assert.match(noProvider.text(), /docker-compose/);
});

test("install --engine podman persists the engine and writes the podman compose override", async (t) => {
  const f = await fixture(t);
  const { initializeInstallation } = await import("../src/index.mjs");
  assert.equal(await run(
    ["install", "--engine", "podman", "--profile", "small", "--non-interactive", "--answers",
      JSON.stringify({ confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false })],
    { ...f.options,
      ensurePodman: async () => ({ code: 0, reexecuted: false }),
      // The podman probes run through the real prerequisites; the engine is mocked.
      execute: await podmanExecute(f.calls) }
  ), 0);
  const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  const podmanFile = await readFile(join(f.root, "compose.podman.yml"), "utf8");
  assert.match(podmanFile, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(podmanFile, /user: "0:0"/);
  const upCall = f.calls.find((spec) => spec.command === "podman" && spec.args.includes("up"));
  assert.ok(upCall, "the runtime starts through podman compose");
  assert.ok(upCall.args.some((arg) => String(arg).endsWith("compose.podman.yml")));
});

test("install refuses engine switches on an existing installation and host-root access under Podman", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.6", profile: "small" });
  const config = await loadConfig(f.root);
  await saveConfig(f.root, { ...config, engine: "docker" });
  await assert.rejects(
    () => run(
      ["install", "--engine", "podman", "--non-interactive", "--answers",
        JSON.stringify({ confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false })],
      f.options
    ),
    /switching engines/
  );
  const podmanRoot = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  t.after(() => rm(podmanRoot, { recursive: true, force: true }));
  await assert.rejects(
    () => run(
      ["install", "--engine", "podman", "--access", "host-root", "--non-interactive", "--answers",
        JSON.stringify({ confirm: true, profile: "small", access: "host-root", companions: false, telemetry: false, open: false })],
      { ...f.options, env: { SPACEAPP_HOME: podmanRoot } }
    ),
    /Host-root access is not supported with Podman/
  );
});

test("doctor reports podman engine facts: version, provider, rootless mode, cgroup and delegation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeInstallation(root, { version: "1.1.6", profile: "small" });
  const config = await loadConfig(root);
  await saveConfig(root, { ...config, engine: "podman" });
  const stdout = io();
  const stderr = io();
  const podmanInfo = {
    host: {
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "memory", "pids"],
      security: { rootless: true }
    },
    store: { graphRoot: "/home/user/.local/share/containers/storage" }
  };
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 }),
    execute: async (spec, ioo) => {
      if (spec.command === "podman" && spec.args[0] === "--version") { ioo.stdout?.write?.(PODMAN_VERSION_OUTPUT); return 0; }
      if (spec.command === "podman" && spec.args[0] === "info") { ioo.stdout?.write?.(JSON.stringify(podmanInfo)); return 0; }
      if (spec.command === "podman" && spec.args[0] === "compose") { ioo.stdout?.write?.("Docker Compose version v2.32.4"); return 0; }
      return 0;
    },
    sleep: async () => {}
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /PASS Podman CLI: available \(5\.2\.1\)/);
  assert.match(stdout.text(), /PASS Podman mode: rootless/);
  assert.match(stdout.text(), /PASS cgroup: cgroup v2/);
  assert.match(stdout.text(), /PASS CPU\/memory limits delegated/);
  assert.ok(stdout.text().includes("PASS Configuration"));
});

test("doctor flags undelgated CPU/memory limits for podman instead of failing late", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeInstallation(root, { version: "1.1.6", profile: "small" });
  const config = await loadConfig(root);
  await saveConfig(root, { ...config, engine: "podman" });
  const stdout = io();
  const stderr = io();
  const podmanInfo = {
    host: { cgroupVersion: "v2", cgroupControllers: ["pids"], security: { rootless: true } }
  };
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 }),
    execute: async (spec, ioo) => {
      if (spec.command === "podman" && spec.args[0] === "--version") { ioo.stdout?.write?.(PODMAN_VERSION_OUTPUT); return 0; }
      if (spec.command === "podman" && spec.args[0] === "info") { ioo.stdout?.write?.(JSON.stringify(podmanInfo)); return 0; }
      if (spec.command === "podman" && spec.args[0] === "compose") { ioo.stdout?.write?.("Docker Compose version v2.32.4"); return 0; }
      return 0;
    },
    sleep: async () => {}
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /FAIL CPU\/memory limits delegated/);
  assert.match(stderr.text(), /Delegate=cpu memory pids/);
});
