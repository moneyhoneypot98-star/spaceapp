import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UNIVERSAL_INSTALL_COMMAND } from "./package-info.mjs";

const DOCKER_TERMS_URL = "https://www.docker.com/legal/docker-subscription-service-agreement/";
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const WINDOWS_DOCKER_DOWNLOADS = Object.freeze({
  x64: "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
  arm64: "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
});
const MAC_DOCKER_DOWNLOADS = Object.freeze({
  x64: "https://desktop.docker.com/mac/main/amd64/Docker.dmg",
  arm64: "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
});
const MAC_ADMIN_PASSWORD_PROMPT =
  "SpaceApp Mac administrator password (input hidden): ";
// Sources:
// https://learn.microsoft.com/windows/package-manager/winget/install
// https://github.com/microsoft/winget-pkgs/tree/master/manifests/d/Docker/DockerDesktop
const WINDOWS_DOCKER_WINGET_ARGS = Object.freeze([
  "install",
  "--id", "Docker.DockerDesktop",
  "--exact",
  "--source", "winget",
  "--silent",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity"
]);

export function windowsPowerShellArgs(operation) {
  const scripts = {
    "install-wsl": [
      "$ErrorActionPreference = 'Stop'; try {",
      "$process = Start-Process -FilePath 'wsl.exe'",
      "-ArgumentList @('--install','--no-distribution')",
      "-Verb RunAs -Wait -PassThru",
      "; exit $process.ExitCode",
      "} catch { exit 1 }"
    ].join(" "),
    "windows-restart-pending": [
      "$pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
      "if ($pending) { exit 0 }",
      "exit 1"
    ].join("; "),
    "register-spaceapp-resume": [
      "$ErrorActionPreference = 'Stop'",
      "$path = $env:SPACEAPP_RESUME_SCRIPT_PATH",
      "if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { exit 1 }",
      "$runOnce = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'",
      "New-Item -Path $runOnce -Force | Out-Null",
      "$command = 'cmd.exe /d /k call \"' + $path + '\"'",
      "New-ItemProperty -Path $runOnce -Name 'SpaceAppResumeInstall' -Value $command -PropertyType String -Force | Out-Null"
    ].join("; "),
    "verify-docker-installer": [
      "$path = $env:SPACEAPP_DOCKER_INSTALLER_PATH",
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
      "$signature = Get-AuthenticodeSignature -LiteralPath $path",
      "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Docker') { exit 1 }"
    ].join("; "),
    "install-docker-desktop": [
      "$path = $env:SPACEAPP_DOCKER_INSTALLER_PATH",
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
      "$process = Start-Process -FilePath $path -ArgumentList @('install','--user','--quiet','--accept-license') -Wait -PassThru",
      "exit $process.ExitCode"
    ].join("; "),
    "start-docker-desktop": [
      "Set-Service -Name 'com.docker.service' -StartupType Automatic -ErrorAction SilentlyContinue",
      "Start-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue",
      "$path = $env:SPACEAPP_DOCKER_DESKTOP_PATH",
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
      "Start-Process -FilePath $path"
    ].join("; "),
    "open-spaceapp-browser": [
      "$ErrorActionPreference = 'Stop'",
      "$url = $env:SPACEAPP_OPEN_URL",
      "$uri = $null",
      "if ([string]::IsNullOrWhiteSpace($url) -or -not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) { exit 1 }",
      "if ($uri.Scheme -ne 'http' -or @('127.0.0.1','0.0.0.0') -notcontains $uri.Host -or $uri.Port -lt 1024 -or $uri.Port -gt 65535) { exit 1 }",
      "$roots = @([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), [Environment]::GetEnvironmentVariable('ProgramFiles'), [Environment]::GetEnvironmentVariable('LOCALAPPDATA')) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }",
      "$edge = $roots | ForEach-Object { Join-Path $_ 'Microsoft\\Edge\\Application\\msedge.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1",
      "if ($edge) { Start-Process -FilePath $edge -ArgumentList @('--no-first-run','--no-default-browser-check',$url); exit 0 }",
      "Start-Process -FilePath 'explorer.exe' -ArgumentList @($url)"
    ].join("; ")
  };
  if (!Object.hasOwn(scripts, operation)) {
    throw new Error("SpaceApp refused an untrusted PowerShell operation.");
  }
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", scripts[operation]];
}

export async function prepareDockerCliPath({
  platform = process.platform,
  env = process.env,
  pathExists = fileExists
} = {}) {
  let directories = [];
  if (platform === "win32") {
    directories = windowsDockerPaths(env).cliDirectories;
  } else if (platform === "darwin") {
    directories = ["/Applications/Docker.app/Contents/Resources/bin"];
  } else {
    return null;
  }
  const directory = await firstExisting(directories, pathExists);
  if (!directory) {
    return null;
  }
  prependPath(env, directory, platform);
  return directory;
}

export async function ensureDockerAvailable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  execute,
  launch = launchDetachedCommand,
  download = downloadFile,
  pathExists = fileExists,
  sleep = wait,
  osRelease,
  installArgs,
  scheduleResume = scheduleWindowsInstallResume,
  confirmRestart = confirmWindowsRestart,
  // Fresh installs only: called when Docker is not ready; returning "podman" continues on rootless
  // Podman instead of installing Docker.
  offerPodman
} = {}) {
  if (await dockerIsReady(execute)) {
    return { code: 0, reexecuted: false };
  }
  // Docker is missing or not reachable: when Podman is already usable, offer it instead of installing
  // Docker. The offer happens before any Docker download/installation. The version output (not just the
  // exit code) must parse, so mocks that only return exit codes never trigger the offer.
  if (offerPodman && (platform === "linux" || platform === "darwin") && await podmanOfferCandidate(execute)) {
    const choice = await offerPodman();
    if (choice === "podman") {
      return { code: 0, reexecuted: false, engine: "podman" };
    }
  }
  if (platform === "win32") {
    return ensureWindowsDocker({
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      launch,
      download,
      pathExists,
      sleep,
      installArgs,
      scheduleResume,
      confirmRestart
    });
  }
  if (platform === "darwin") {
    return ensureMacDocker({
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      launch,
      download,
      pathExists,
      sleep,
      installArgs
    });
  }
  return ensureLinuxDocker({
    arch,
    env,
    stdin,
    stdout,
    stderr,
    execute,
    download,
    sleep,
    osRelease,
    installArgs
  });
}

async function ensureWindowsDocker({
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  launch,
  download,
  pathExists,
  sleep,
  installArgs,
  scheduleResume,
  confirmRestart
}) {
  const paths = windowsDockerPaths(env);
  let application = await firstExisting(paths.applications, pathExists);

  if (!application) {
    stdout.write("Docker Desktop is required and is not installed.\n");
    const accepted = await confirmDesktopInstall({
      platformName: "Windows",
      stdin,
      stdout,
      autoConfirm: Boolean(installArgs?.autoConfirm)
    });
    if (!accepted) {
      stderr.write("Docker Desktop installation was cancelled.\n");
      return { code: 1, reexecuted: false };
    }
  }

  let wslInstalledNow = false;
  const wslCode = await execute(
    { command: "wsl.exe", args: ["--version"] },
    { stdin, stdout: null, stderr: null }
  );
  if (wslCode !== 0) {
    stdout.write("Installing the Windows Subsystem for Linux 2 support required by Docker Desktop...\n");
    const installWslCode = await execute(
      {
        command: "powershell.exe",
        operation: "install-wsl"
      },
      { stdin, stdout, stderr }
    );
    if (installWslCode !== 0) {
      stderr.write(
        `Windows could not enable WSL2 automatically. Run "${UNIVERSAL_INSTALL_COMMAND}" from an Administrator Command Prompt, restart Windows if requested, and run it again.\n`
      );
      return { code: installWslCode, reexecuted: false };
    }
    wslInstalledNow = true;
  }

  const restartPendingCode = await execute(
    { command: "powershell.exe", operation: "windows-restart-pending" },
    { stdin, stdout: null, stderr: null }
  );
  if (wslInstalledNow || restartPendingCode === 0) {
    const scheduleCode = await scheduleResume({
      ...installArgs,
      execute,
      stdin,
      stdout,
      stderr
    });
    if (scheduleCode !== 0) {
      stderr.write(
        "Windows must restart to finish WSL2, but SpaceApp could not schedule automatic continuation.\n" +
        `Restart Windows, then run "${UNIVERSAL_INSTALL_COMMAND}" again.\n`
      );
      return { code: scheduleCode, reexecuted: false };
    }
    stdout.write(
      "Windows must restart to finish enabling WSL2.\n" +
      "SpaceApp is scheduled to resume automatically after you sign in.\n"
    );
    const restartNow = await confirmRestart({
      stdin,
      stdout,
      question: "Restart Windows in 15 seconds and continue SpaceApp after sign-in? [y/N] "
    });
    if (!restartNow) {
      stdout.write(
        "Restart Windows when ready. SpaceApp will resume automatically the next time you sign in.\n"
      );
      return { code: 0, reexecuted: true };
    }
    const restartCode = await execute(
      {
        command: "shutdown.exe",
        args: [
          "/r",
          "/t", "15",
          "/c", "SpaceApp will continue automatically after you sign in."
        ]
      },
      { stdin, stdout, stderr }
    );
    if (restartCode !== 0) {
      stderr.write(
        "Windows restart could not be scheduled. Restart Windows manually; SpaceApp will resume after sign-in.\n"
      );
      return { code: restartCode, reexecuted: false };
    }
    stdout.write(
      "Windows will restart in 15 seconds. Save your work; run \"shutdown /a\" to cancel the countdown.\n"
    );
    return { code: 0, reexecuted: true };
  }

  if (!application) {
    const wingetCode = await execute(
      { command: "winget.exe", args: ["--version"] },
      { stdin, stdout: null, stderr: null }
    );
    if (wingetCode === 0) {
      stdout.write(
        "Installing Docker Desktop through Windows Package Manager with manifest hash verification...\n"
      );
      const installCode = await execute(
        { command: "winget.exe", args: [...WINDOWS_DOCKER_WINGET_ARGS] },
        { stdin, stdout, stderr }
      );
      if (installCode === 0) {
        application = await firstExisting(paths.applications, pathExists);
        if (!application) {
          stderr.write(
            "Windows Package Manager reported success, but Docker Desktop could not be found.\n"
          );
          return { code: 1, reexecuted: false };
        }
      } else {
        stdout.write(
          "Windows Package Manager could not install Docker Desktop; trying Docker's signed direct installer...\n"
        );
      }
    }
  }

  if (!application) {
    const downloadUrl = WINDOWS_DOCKER_DOWNLOADS[arch];
    if (!downloadUrl) {
      stderr.write(`Docker Desktop automatic installation does not support Windows architecture "${arch}".\n`);
      return { code: 1, reexecuted: false };
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
    const installer = join(temporaryRoot, "Docker Desktop Installer.exe");
    const installerEnv = {
      SPACEAPP_DOCKER_INSTALLER_PATH: installer
    };
    try {
      stdout.write("Downloading Docker Desktop from Docker's official distribution service...\n");
      await download(downloadUrl, installer);
      const signatureCode = await execute({
        command: "powershell.exe",
        operation: "verify-docker-installer",
        env: installerEnv
      }, { stdin, stdout: null, stderr });
      if (signatureCode !== 0) {
        stderr.write("The Docker Desktop installer signature is not valid. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const installCode = await execute(
        {
          command: "powershell.exe",
          operation: "install-docker-desktop",
          env: installerEnv
        },
        { stdin, stdout, stderr }
      );
      if (installCode !== 0) {
        stderr.write("Docker Desktop installation failed before SpaceApp downloaded any images.\n");
        return { code: installCode, reexecuted: false };
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    application = await firstExisting(paths.applications, pathExists);
    if (!application) {
      stderr.write("Docker Desktop reported success, but its application could not be found.\n");
      return { code: 1, reexecuted: false };
    }
  } else {
    stdout.write("Docker Desktop is installed but is not running. Starting it now...\n");
  }

  await prepareDockerCliPath({ platform: "win32", env, pathExists });
  stdout.write(
    "Opening Docker Desktop for its first-run setup.\n" +
    "If Docker shows \"Welcome to Docker\", select \"Skip\" in the top-right (or sign in), and accept any remaining Docker prompt.\n" +
    "Keep this terminal open; SpaceApp will continue automatically when Docker is ready (up to 10 minutes).\n"
  );
  await execute(
    { command: "docker", args: ["desktop", "start", "--detach"] },
    { stdin, stdout: null, stderr: null }
  );
  const launchCode = await launch({
    operation: "start-docker-desktop",
    env: {
      SPACEAPP_DOCKER_DESKTOP_PATH: application
    }
  });
  if (launchCode !== 0) {
    stderr.write("Docker Desktop is installed, but SpaceApp could not start it.\n");
    return { code: launchCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep, attempts: 300 })) {
    stdout.write("Docker Desktop is ready.\n");
    return { code: 0, reexecuted: false };
  }
  stderr.write(
    `Docker Desktop did not become ready after 10 minutes. Open Docker Desktop and complete its first-run setup (select "Skip" on "Welcome to Docker" or sign in), restart Windows if requested, then run "${UNIVERSAL_INSTALL_COMMAND}" again.\n`
  );
  return { code: 1, reexecuted: false };
}

async function ensureMacDocker({
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  launch,
  download,
  pathExists,
  sleep,
  installArgs
}) {
  const application = "/Applications/Docker.app";
  const cliDirectory = posix.join(application, "Contents", "Resources", "bin");
  let installed = await pathExists(application);

  if (!installed) {
    stdout.write("Docker Desktop is required and is not installed.\n");
    const accepted = await confirmDesktopInstall({
      platformName: "macOS",
      stdin,
      stdout,
      autoConfirm: Boolean(installArgs?.autoConfirm)
    });
    if (!accepted) {
      stderr.write("Docker Desktop installation was cancelled.\n");
      return { code: 1, reexecuted: false };
    }
    const downloadUrl = MAC_DOCKER_DOWNLOADS[arch];
    if (!downloadUrl) {
      stderr.write(`Docker Desktop automatic installation does not support macOS architecture "${arch}".\n`);
      return { code: 1, reexecuted: false };
    }
    const username = String(env.USER || "");
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      stderr.write("A valid macOS username is required for Docker Desktop installation.\n");
      return { code: 1, reexecuted: false };
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
    const diskImage = join(temporaryRoot, "Docker.dmg");
    const mountedApplication = "/Volumes/Docker/Docker.app";
    const installer = posix.join(mountedApplication, "Contents", "MacOS", "install");
    let mounted = false;
    try {
      stdout.write("Downloading Docker Desktop from Docker's official distribution service...\n");
      await download(downloadUrl, diskImage);
      const attachCode = await execute(
        { command: "hdiutil", args: ["attach", "-nobrowse", diskImage] },
        { stdin, stdout, stderr }
      );
      if (attachCode !== 0) {
        return { code: attachCode, reexecuted: false };
      }
      mounted = true;
      const signatureCode = await execute({
        command: "codesign",
        args: ["--verify", "--deep", "--strict", mountedApplication]
      }, { stdin, stdout: null, stderr: null });
      if (signatureCode !== 0) {
        stderr.write("The Docker Desktop application signature is not valid. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const gatekeeperCode = await execute({
        command: "spctl",
        args: ["--assess", "--type", "execute", "--verbose=4", mountedApplication]
      }, { stdin, stdout: null, stderr: null });
      if (gatekeeperCode !== 0) {
        stderr.write("macOS Gatekeeper did not accept Docker Desktop. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      stdout.write("Docker Desktop signature and macOS trust verification passed.\n");
      stdout.write(
        "macOS administrator authorization is required to install Docker Desktop.\n" +
        "Enter the password for your Mac administrator account—not a Docker or SpaceApp password.\n" +
        "Characters are not displayed while you type. SpaceApp does not read, store, or log this password.\n"
      );
      const installCode = await execute({
        command: "sudo",
        args: [
          "-p",
          MAC_ADMIN_PASSWORD_PROMPT,
          installer,
          "--accept-license",
          `--user=${username}`
        ]
      }, { stdin, stdout, stderr });
      if (installCode !== 0) {
        stderr.write(
          "macOS authorization failed. Docker Desktop must be installed by a Mac administrator account.\n" +
          "Enter that account's password—not a Docker or SpaceApp password—and rerun the same SpaceApp install command.\n" +
          "No SpaceApp images were downloaded.\n"
        );
        return { code: installCode, reexecuted: false };
      }
    } finally {
      if (mounted) {
        await execute(
          { command: "hdiutil", args: ["detach", "/Volumes/Docker"] },
          { stdin, stdout: null, stderr: null }
        );
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    installed = await pathExists(application);
    if (!installed) {
      stderr.write("Docker Desktop reported success, but /Applications/Docker.app could not be found.\n");
      return { code: 1, reexecuted: false };
    }
  } else {
    stdout.write("Docker Desktop is installed but is not running. Starting it now...\n");
  }

  await prepareDockerCliPath({ platform: "darwin", env, pathExists });
  const launchCode = await launch({ operation: "open-docker-desktop" });
  if (launchCode !== 0) {
    stderr.write("Docker Desktop is installed, but SpaceApp could not start it.\n");
    return { code: launchCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep, attempts: 300 })) {
    stdout.write("Docker Desktop is ready.\n");
    return { code: 0, reexecuted: false };
  }
  stderr.write(
    `Docker Desktop did not become ready after 10 minutes. Complete any Docker Desktop prompt, then run "${UNIVERSAL_INSTALL_COMMAND}" again.\n`
  );
  return { code: 1, reexecuted: false };
}

async function ensureLinuxDocker({
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  download,
  sleep,
  osRelease,
  installArgs
}) {
  const cliAvailable = await dockerCliAndComposeAreAvailable(execute);
  if (!cliAvailable) {
    const release = osRelease ?? await readLinuxOsRelease();
    stdout.write(`Docker Engine is required and is not installed. Installing it for ${release.ID}...\n`);
    const installCode = await installLinuxDockerEngine({
      arch,
      release,
      stdin,
      stdout,
      stderr,
      execute,
      download
    });
    if (installCode !== 0) {
      return { code: installCode, reexecuted: false };
    }
  } else {
    stdout.write("Docker Engine is installed but is not ready. Starting it now...\n");
  }

  const startCode = await execute(
    { command: "sudo", args: ["systemctl", "enable", "--now", "docker"] },
    { stdin, stdout, stderr }
  );
  if (startCode !== 0) {
    stderr.write("Docker Engine was installed, but its system service could not be started.\n");
    return { code: startCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep, attempts: 15 })) {
    stdout.write("Docker Engine is ready.\n");
    return { code: 0, reexecuted: false };
  }
  if (env.SPACEAPP_PREREQUISITES_BOOTSTRAPPED === "1") {
    stderr.write("Docker Engine is running, but the current user still cannot access it.\n");
    return { code: 1, reexecuted: false };
  }

  const username = String(env.SUDO_USER || env.USER || "");
  if (!/^[A-Za-z0-9._-]+$/.test(username) || username === "root") {
    stderr.write("A valid non-root Linux username is required for Docker Engine access.\n");
    return { code: 1, reexecuted: false };
  }
  stdout.write(
    [
      "Docker's official post-install flow uses the docker group.",
      "Membership grants root-level privileges on this host.",
      `Adding ${username} to the docker group automatically and continuing.`
    ].join("\n") + "\n"
  );
  const groupCode = await execute(
    { command: "sudo", args: ["usermod", "-aG", "docker", username] },
    { stdin, stdout, stderr }
  );
  if (groupCode !== 0) {
    stderr.write(`SpaceApp could not add ${username} to the docker group.\n`);
    return { code: groupCode, reexecuted: false };
  }

  const reentryCommand = linuxReentryCommand(installArgs);
  stdout.write("Docker Engine is ready. Continuing SpaceApp installation with the new group membership...\n");
  const reentryCode = await execute(
    { command: "sg", args: ["docker", "-c", reentryCommand] },
    { stdin, stdout, stderr }
  );
  return { code: reentryCode, reexecuted: true };
}

async function confirmDesktopInstall({ platformName, stdin, stdout, autoConfirm = false }) {
  if (autoConfirm) {
    stdout.write(`Installing Docker Desktop for ${platformName} automatically as approved in setup plan...\n`);
    return true;
  }
  return confirmQuestion({
    stdin,
    stdout,
    question:
      `Review the Docker Desktop terms at ${DOCKER_TERMS_URL}\n` +
      `Install Docker Desktop for ${platformName} and accept those terms? [y/N] `
  });
}

async function confirmWindowsRestart({ stdin, stdout, question }) {
  return confirmQuestion({ stdin, stdout, question });
}

async function confirmQuestion({ stdin, stdout, question }) {
  const readline = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  try {
    const answer = await readline.question(question);
    return /^(?:y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    readline.close();
  }
}

async function dockerCliAndComposeAreAvailable(execute) {
  for (const spec of [
    { command: "docker", args: ["--version"] },
    { command: "docker", args: ["compose", "version"] }
  ]) {
    if (await execute(spec, { stdout: null, stderr: null }) !== 0) {
      return false;
    }
  }
  return true;
}

async function dockerIsReady(execute) {
  for (const spec of [
    { command: "docker", args: ["--version"] },
    { command: "docker", args: ["compose", "version"] },
    { command: "docker", args: ["info"] }
  ]) {
    if (await execute(spec, { stdout: null, stderr: null }) !== 0) {
      return false;
    }
  }
  return true;
}

async function installLinuxDockerEngine({
  arch,
  release,
  stdin,
  stdout,
  stderr,
  execute,
  download
}) {
  const id = String(release?.ID || "").toLowerCase();
  const idFamily = new Set([
    id,
    ...String(release?.ID_LIKE || "").toLowerCase().split(/\s+/).filter(Boolean)
  ]);
  if (id === "ubuntu" || id === "debian") {
    return installAptDockerEngine({
      arch,
      id,
      codename: release.VERSION_CODENAME || release.UBUNTU_CODENAME,
      stdin,
      stdout,
      stderr,
      execute,
      download
    });
  }
  if (id === "fedora" || id === "rhel" || id === "centos") {
    return installDnfDockerEngine({ id, stdin, stdout, stderr, execute });
  }
  if (
    idFamily.has("arch") ||
    idFamily.has("archlinux") ||
    idFamily.has("cachyos")
  ) {
    return installPacmanDockerEngine({ stdin, stdout, stderr, execute });
  }
  stderr.write(
    `Automatic Docker Engine installation is not yet supported for Linux distribution "${id || "unknown"}". ` +
    "Install Docker Engine and the Compose plugin from https://docs.docker.com/engine/install/ and rerun the same command.\n"
  );
  return 1;
}

function installPacmanDockerEngine({ stdin, stdout, stderr, execute }) {
  return execute(
    {
      command: "sudo",
      args: [
        "pacman",
        "-S",
        "--needed",
        "--noconfirm",
        "docker",
        "docker-compose"
      ]
    },
    { stdin, stdout, stderr }
  );
}

async function installAptDockerEngine({
  arch,
  id,
  codename,
  stdin,
  stdout,
  stderr,
  execute,
  download
}) {
  const dockerArch = { x64: "amd64", arm64: "arm64" }[arch];
  if (!dockerArch || !/^[a-z0-9._-]+$/.test(String(codename || ""))) {
    stderr.write("This Debian/Ubuntu architecture or release codename is not supported automatically.\n");
    return 1;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
  const signingKey = join(temporaryRoot, "docker.asc");
  const repositoryFile = join(temporaryRoot, "docker.list");
  const repositoryBase = `https://download.docker.com/linux/${id}`;
  try {
    await download(`${repositoryBase}/gpg`, signingKey);
    await writeFile(
      repositoryFile,
      `deb [arch=${dockerArch} signed-by=/etc/apt/keyrings/docker.asc] ${repositoryBase} ${codename} stable\n`,
      { mode: 0o600, flag: "wx" }
    );
    for (const spec of [
      { command: "sudo", args: ["install", "-m", "0755", "-d", "/etc/apt/keyrings"] },
      { command: "sudo", args: ["install", "-m", "0644", signingKey, "/etc/apt/keyrings/docker.asc"] },
      {
        command: "sudo",
        args: ["install", "-m", "0644", repositoryFile, "/etc/apt/sources.list.d/docker.list"]
      },
      { command: "sudo", args: ["apt-get", "update"] },
      {
        command: "sudo",
        args: [
          "apt-get",
          "install",
          "-y",
          "docker-ce",
          "docker-ce-cli",
          "containerd.io",
          "docker-buildx-plugin",
          "docker-compose-plugin"
        ]
      }
    ]) {
      const code = await execute(spec, { stdin, stdout, stderr });
      if (code !== 0) {
        return code;
      }
    }
    return 0;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function installDnfDockerEngine({ id, stdin, stdout, stderr, execute }) {
  const repositoryUrl = `https://download.docker.com/linux/${id}/docker-ce.repo`;
  const repositoryArgs = id === "fedora"
    ? ["dnf", "config-manager", "addrepo", "--from-repofile", repositoryUrl]
    : ["dnf", "config-manager", "--add-repo", repositoryUrl];
  const pluginCode = await execute(
    { command: "sudo", args: ["dnf", "-y", "install", "dnf-plugins-core"] },
    { stdin, stdout, stderr }
  );
  if (pluginCode !== 0) {
    return pluginCode;
  }

  let repositoryCode = await execute(
    { command: "sudo", args: repositoryArgs },
    { stdin, stdout, stderr }
  );
  if (repositoryCode !== 0 && id === "fedora") {
    stdout.write("The DNF5 repository command was unavailable; retrying with DNF4 syntax...\n");
    repositoryCode = await execute(
      {
        command: "sudo",
        args: ["dnf", "config-manager", "--add-repo", repositoryUrl]
      },
      { stdin, stdout, stderr }
    );
  }
  if (repositoryCode !== 0) {
    return repositoryCode;
  }

  return execute(
    {
      command: "sudo",
      args: [
        "dnf",
        "-y",
        "install",
        "docker-ce",
        "docker-ce-cli",
        "containerd.io",
        "docker-buildx-plugin",
        "docker-compose-plugin"
      ]
    },
    { stdin, stdout, stderr }
  );
}

async function readLinuxOsRelease() {
  const content = await readFile("/etc/os-release", "utf8");
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    values[match[1]] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function linuxReentryCommand({
  requestedProfile = "auto",
  requestedAccessMode,
  noOpen = false
} = {}) {
  if (!["auto", "small", "medium", "large", "light", "standard"].includes(requestedProfile)) {
    throw new Error("Invalid SpaceApp profile for Docker group re-entry.");
  }
  const entrypoint = fileURLToPath(new URL("../bin/spaceapp.mjs", import.meta.url));
  return [
    "/usr/bin/env",
    "SPACEAPP_PREREQUISITES_BOOTSTRAPPED=1",
    process.execPath,
    entrypoint,
    "install",
    "--profile",
    requestedProfile,
    ...installAccessArgs(requestedAccessMode, "Docker group re-entry"),
    ...(noOpen ? ["--no-open"] : [])
  ].map(shellQuote).join(" ");
}

export function windowsResumeScript({
  executable = process.execPath,
  entrypoint = fileURLToPath(new URL("../bin/spaceapp.mjs", import.meta.url)),
  requestedProfile = "auto",
  requestedAccessMode,
  noOpen = false
} = {}) {
  if (!["auto", "small", "medium", "large", "light", "standard"].includes(requestedProfile)) {
    throw new Error("Invalid SpaceApp profile for Windows resume.");
  }
  if (typeof noOpen !== "boolean") {
    throw new Error("Invalid SpaceApp browser option for Windows resume.");
  }
  for (const [name, value] of [["executable", executable], ["entrypoint", entrypoint]]) {
    if (
      typeof value !== "string" ||
      !win32.isAbsolute(value) ||
      /["\r\n%]/.test(value)
    ) {
      throw new Error(`Invalid SpaceApp Windows resume ${name}.`);
    }
  }
  const command = [
    windowsBatchQuote(executable),
    windowsBatchQuote(entrypoint),
    "install",
    "--profile",
    requestedProfile,
    ...installAccessArgs(requestedAccessMode, "Windows resume"),
    ...(noOpen ? ["--no-open"] : [])
  ].join(" ");
  return [
    "@echo off",
    "setlocal",
    command,
    'set "SPACEAPP_RESUME_EXIT=%ERRORLEVEL%"',
    'if "%SPACEAPP_RESUME_EXIT%"=="0" del /f /q "%~f0"',
    'if not "%SPACEAPP_RESUME_EXIT%"=="0" echo SpaceApp setup needs attention. Review the error above, then run this file again.',
    "exit /b %SPACEAPP_RESUME_EXIT%",
    ""
  ].join("\r\n");
}

async function scheduleWindowsInstallResume({
  root,
  requestedProfile = "auto",
  requestedAccessMode,
  noOpen = false,
  execute,
  stdin,
  stdout,
  stderr
} = {}) {
  if (
    typeof root !== "string" ||
    !win32.isAbsolute(root) ||
    /["\r\n%]/.test(root)
  ) {
    stderr?.write("SpaceApp could not determine a safe Windows resume path.\n");
    return 1;
  }
  const resumePath = win32.join(root, "resume-install.cmd");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    resumePath,
    windowsResumeScript({ requestedProfile, requestedAccessMode, noOpen }),
    { encoding: "utf8", mode: 0o600 }
  );
  const code = await execute(
    {
      command: "powershell.exe",
      operation: "register-spaceapp-resume",
      env: { SPACEAPP_RESUME_SCRIPT_PATH: resumePath }
    },
    { stdin, stdout: null, stderr }
  );
  if (code !== 0) {
    await rm(resumePath, { force: true });
  }
  return code;
}

function installAccessArgs(requestedAccessMode, context) {
  if (requestedAccessMode === undefined) {
    return [];
  }
  if (requestedAccessMode === "isolated" || requestedAccessMode === "host-root") {
    return ["--access", requestedAccessMode];
  }
  throw new Error(`Invalid SpaceApp access mode for ${context}.`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function windowsBatchQuote(value) {
  return `"${String(value)}"`;
}

async function waitForDocker({ execute, sleep, attempts = 90 }) {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (await dockerIsReady(execute)) {
      return true;
    }
    if (attempt < attempts) {
      await sleep(2_000);
    }
  }
  return false;
}

function windowsDockerPaths(env) {
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles || env.PROGRAMFILES;
  return {
    applications: [
      localAppData && win32.join(localAppData, "Programs", "DockerDesktop", "Docker Desktop.exe"),
      programFiles && win32.join(programFiles, "Docker", "Docker", "Docker Desktop.exe")
    ].filter(Boolean),
    cliDirectories: [
      localAppData && win32.join(localAppData, "Programs", "DockerDesktop", "resources", "bin"),
      programFiles && win32.join(programFiles, "Docker", "Docker", "resources", "bin")
    ].filter(Boolean)
  };
}

async function firstExisting(paths, pathExists) {
  for (const path of paths) {
    if (await pathExists(path)) {
      return path;
    }
  }
  return null;
}

function prependPath(env, directory, platform = process.platform) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const pathDelimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
  const entries = String(env[pathKey] || "").split(pathDelimiter).filter(Boolean);
  if (!entries.includes(directory)) {
    env[pathKey] = [directory, ...entries].join(pathDelimiter);
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function downloadFile(url, target, {
  timeoutMs = DOWNLOAD_TIMEOUT_MS
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Docker download timeout must be a positive number.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`Docker download failed with HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal }
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Docker download timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function launchDetachedCommand(spec) {
  return new Promise((resolve) => {
    const options = {
      detached: true,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      shell: false,
      stdio: "ignore"
    };
    let child;
    try {
      if (spec.operation === "start-docker-desktop") {
        child = spawn("powershell.exe", windowsPowerShellArgs(spec.operation), options);
      } else if (spec.operation === "open-docker-desktop") {
        child = spawn("open", ["-a", "/Applications/Docker.app"], options);
      } else if (spec.operation === "start-podman-service") {
        // Detached rootless user API socket: listens on $XDG_RUNTIME_DIR/podman/podman.sock.
        child = spawn("podman", ["system", "service", "--time=0"], options);
      } else {
        resolve(1);
        return;
      }
    } catch {
      resolve(1);
      return;
    }
    child.once("error", () => resolve(1));
    child.once("spawn", () => {
      // macOS open exits after Launch Services accepts or rejects the launch.
      // Spawning the utility alone is not evidence that it opened Docker.
      if (spec.operation === "open-docker-desktop") return;
      child.unref();
      resolve(0);
    });
    if (spec.operation === "open-docker-desktop") {
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    }
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Rootless Podman support. The launcher requires Podman >= 4.9 (the `podman compose` provider
 * dispatch and the keep-id uid=/gid= mapping options; Ubuntu 24.04 ships 4.9.3, Fedora/RHEL 5.x) with a
 * compose provider for the compose files: docker-compose v2 (>= 2.20, for `depends_on` health conditions
 * incl. `required: false`) is the supported provider; podman-compose works for simpler stacks but is not
 * tested here. Installing Podman itself is out of scope; the launcher prints per-distribution instructions. */
export const PODMAN_MIN_VERSION = "4.9.0";
export const COMPOSE_PROVIDER_MIN_VERSION = "2.20.0";

export function parsePodmanVersion(output) {
  const match = /podman(?:\s+version)?\s+(\d+\.\d+(?:\.\d+)?)/.exec(output ?? "");
  return match ? match[1] : null;
}

export function versionAtLeast(actual, minimum) {
  if (!actual) return false;
  const [a, b] = [actual.split(".").map(Number), minimum.split(".").map(Number)];
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0, right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function runProbe(execute, spec) {
  try {
    return await execute(spec, { stdin: null, stdout: null, stderr: null });
  } catch {
    return 127;
  }
}

export async function podmanIsReady(execute) {
  return await runProbe(execute, { command: "podman", args: ["info"] }) === 0;
}

/** True only when `podman --version` prints a parseable version >= 5 and `podman info` succeeds. */
async function podmanOfferCandidate(execute) {
  const version = parsePodmanVersion(await probeOutput(execute, { command: "podman", args: ["--version"] }));
  if (!version || !versionAtLeast(version, PODMAN_MIN_VERSION)) return false;
  return await podmanIsReady(execute);
}

/** Non-secret engine facts for `doctor` and the support bundle. Version probes run first; the richer
 * facts come from `podman info --format json`. No paths, images or credentials beyond the engine's own
 * public fields are included. */
export async function podmanEngineFacts({ execute }) {
  const facts = { available: false, version: null, rootless: null, cgroupVersion: null,
    cgroupControllers: [], composeProvider: null, composeProviderVersion: null };
  const versionOutput = await probeOutput(execute, { command: "podman", args: ["--version"] });
  const version = parsePodmanVersion(versionOutput);
  if (await runProbe(execute, { command: "podman", args: ["--version"] }) !== 0) {
    return facts;
  }
  facts.available = true;
  facts.version = version;
  const infoOutput = await probeOutput(execute, { command: "podman", args: ["info", "--format", "{{json .}}"] });
  try {
    const info = JSON.parse(infoOutput);
    facts.rootless = info?.host?.security?.rootless ?? null;
    facts.cgroupVersion = info?.host?.cgroupVersion ?? null;
    facts.cgroupControllers = Array.isArray(info?.host?.cgroupControllers) ? info.host.cgroupControllers : [];
  } catch { /* Facts stay partial; doctor still reports the version probe. */ }
  return facts;
}

async function probeOutput(execute, spec) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try {
    const code = await execute({ ...spec, timeoutMs: 15000 }, { stdout, stderr: null });
    return code === 0 ? output.trim() : "";
  } catch { return ""; }
}

export async function podmanComposeProviderFacts({ execute }) {
  const output = await probeOutput(execute, { command: "podman", args: ["compose", "version"] });
  if (!output) return { available: false, name: null, version: null };
  const version = /v?(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null;
  const name = /docker[- ]compose/i.test(output) ? "docker-compose" : /podman-compose/i.test(output) ? "podman-compose" : "compose";
  return { available: true, name, version };
}

/** Refuses Windows (out of scope), then verifies Podman >= 5 is installed and reachable, and that a
 * compose provider exists. Docker stays the default; this path only runs with `--engine podman`. */
export async function ensurePodmanAvailable({
  platform = process.platform,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  execute,
  sleep = wait,
  launch = launchDetachedCommand
} = {}) {
  if (platform === "win32") {
    stderr.write("Podman is supported on Linux and macOS only (Podman Desktop on WSL is out of scope). Use --engine docker.\n");
    return { code: 1, reexecuted: false };
  }
  const versionOutput = await probeOutput(execute, { command: "podman", args: ["--version"] });
  const version = parsePodmanVersion(versionOutput);
  if (!version) {
    stderr.write(`Podman was not found on PATH. ${podmanInstallHelp(platform)}\n`);
    return { code: 1, reexecuted: false };
  }
  if (!versionAtLeast(version, PODMAN_MIN_VERSION)) {
    stderr.write(`Podman ${version} is too old. SpaceApp needs Podman ${PODMAN_MIN_VERSION} or newer (rootless) ${podmanInstallHelp(platform)}\n`);
    return { code: 1, reexecuted: false };
  }
  if (!await podmanIsReady(execute)) {
    if (platform === "darwin") {
      stderr.write("Podman is installed but its machine is not running. Start it with `podman machine init && podman machine start`, then run install again.\n");
    } else {
      stderr.write("Podman is installed but `podman info` failed. Check that your user session can run rootless containers (kernel user namespaces enabled), then run install again.\n");
    }
    return { code: 1, reexecuted: false };
  }
  const provider = await ensurePodmanComposeProvider({ platform, execute, sleep, launch, stderr });
  if (provider !== 0) {
    return { code: provider, reexecuted: false };
  }
  stdout.write(`Podman ${version} is ready (rootless Podman uses your own user account; no root daemon runs).\n`);
  return { code: 0, reexecuted: false };
}

/** docker-compose v2 talks to Podman over its user API socket; `podman compose` starts the provider
 * with DOCKER_HOST pointing there when the socket is active. Without the socket the provider fails
 * late, so the launcher starts a detached rootless `podman system service` when needed. */
export async function ensurePodmanComposeProvider({
  platform = process.platform,
  execute,
  sleep = wait,
  launch = launchDetachedCommand,
  stderr = process.stderr
} = {}) {
  let provider = await podmanComposeProviderFacts({ execute });
  if (provider.available && !versionAtLeast(provider.version ?? "0", COMPOSE_PROVIDER_MIN_VERSION)) {
    stderr.write(
      `The compose provider ${provider.name} ${provider.version ?? "(unknown version)"} is too old. ` +
      `SpaceApp needs docker-compose v2 ${COMPOSE_PROVIDER_MIN_VERSION} or newer for depends_on health conditions. Update it, then run install again.\n`
    );
    return 1;
  }
  const socketPath = await podmanApiSocketPath();
  if (provider.available && socketPath) {
    // docker-compose v2 reaches Podman over the user API socket; podman compose does not export it on
    // every version, so point the provider (and only the provider) at it. Never overrides an existing
    // DOCKER_HOST the user configured.
    process.env.DOCKER_HOST ??= `unix://${socketPath}`;
    return 0;
  }
  if (!provider.available) {
    stderr.write(
      "No compose provider for `podman compose` was found. Install docker-compose v2 (for example " +
      "`sudo apt-get install docker-compose-v2` on Ubuntu/Debian or the docker-compose plugin of your distribution) " +
      "and run install again.\n"
    );
    return 1;
  }
  const launched = await launch({ operation: "start-podman-service" }).catch(() => 1);
  if (launched !== 0) {
    stderr.write("The compose provider is installed but the Podman API socket is not active. " +
      "Enable it with `systemctl --user enable --now podman.socket`, then run install again.\n");
    return 1;
  }
  let startedSocketPath = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    startedSocketPath = await podmanApiSocketPath();
    if (startedSocketPath) break;
    await sleep(1000);
  }
  if (!startedSocketPath) {
    stderr.write("The Podman API socket did not appear. Enable it with `systemctl --user enable --now podman.socket`, then run install again.\n");
    return 1;
  }
  process.env.DOCKER_HOST ??= `unix://${startedSocketPath}`;
  return 0;
}

async function podmanApiSocketPath() {
  // The user service socket lives in the runtime dir of the invoking user (e.g. /run/user/1000).
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === "function" ? process.getuid() : 0}`;
  const path = join(runtimeDir, "podman", "podman.sock");
  try {
    await access(path, 0); // F_OK
    return path;
  } catch {
    return null;
  }
}

export function podmanInstallHelp(platform) {
  if (platform === "darwin") {
    return "Install it with `brew install podman` (https://podman.io/docs/installation).";
  }
  return "Install it with your package manager, for example `sudo dnf install podman` (Fedora/RHEL), " +
    "`sudo apt-get install podman` (Debian/Ubuntu) or `sudo zypper install podman` (openSUSE).";
}

/** macOS only: the Podman machine must have enough CPU, memory and disk for the requested profile.
 * Returns the checks doctor prints and resize instructions when a resource falls short. */
export async function podmanMachineResourceChecks({ execute, profile, profileRequirements }) {
  if (process.platform !== "darwin") return [];
  const output = await probeOutput(execute, { command: "podman", args: ["machine", "inspect", "--format", "{{json .}}"] });
  let machines = null;
  try { machines = JSON.parse(output); } catch { return []; }
  const machine = Array.isArray(machines) ? machines.find((item) => item?.State === "Running") ?? machines[0] : machines;
  if (!machine) return [{ name: "Podman machine", ok: false, detail: "No Podman machine exists. Create one with `podman machine init`." }];
  const cpuCount = Number(machine.CPUs ?? machine.cpus ?? 0);
  const memoryBytes = Number(machine.Memory ?? machine.memory ?? 0);
  const diskBytes = Number(machine.DiskSize ?? machine.diskSize ?? 0) * (1024 ** 3);
  const { cpuCount: requiredCpus, memoryBytes: requiredMemory, freshDiskBytes: requiredDisk } = profileRequirements;
  const checks = [
    { name: "Podman machine CPUs", ok: cpuCount >= requiredCpus,
      detail: `${cpuCount} of ${requiredCpus} needed. Resize with \`podman machine set --cpus ${requiredCpus} ${machine.Name ?? "podman-machine-default"}\`, then restart the machine.` },
    { name: "Podman machine memory", ok: memoryBytes >= requiredMemory,
      detail: `${(memoryBytes / 1024 ** 3).toFixed(1)} GiB of ${(requiredMemory / 1024 ** 3).toFixed(1)} GiB needed. Resize with \`podman machine set --memory ${Math.ceil(requiredMemory / 1024 ** 3)} ${machine.Name ?? "podman-machine-default"}\`, then restart the machine.` },
    { name: "Podman machine disk", ok: diskBytes >= requiredDisk,
      detail: `${(diskBytes / 1024 ** 3).toFixed(1)} GiB of ${(requiredDisk / 1024 ** 3).toFixed(1)} GiB needed. Grow the disk or recreate the machine with a larger disk size, then run install again.` },
    { name: "Podman machine state", ok: machine.State === "Running",
      detail: machine.State === "Running" ? "running" : "not running. Start it with `podman machine start`." }
  ];
  return checks;
}



