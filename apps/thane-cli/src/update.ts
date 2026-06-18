import { CLI_PACKAGE_NAME, CLI_VERSION } from "./version.js";

export type UpdateStatus =
  | { state: "checking" }
  | { state: "latest"; currentVersion: string; latestVersion: string; checkedAt: string }
  | { state: "ahead"; currentVersion: string; latestVersion: string; checkedAt: string }
  | { state: "available"; currentVersion: string; latestVersion: string; checkedAt: string; installCommand: string }
  | { state: "unavailable"; currentVersion: string; error: string; checkedAt: string };

let cached: { status: UpdateStatus; checkedAtMs: number } | undefined;

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part));
  const right = b.split(".").map((part) => Number(part));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export async function checkForUpdate(options: { force?: boolean; cacheMs?: number } = {}): Promise<UpdateStatus> {
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  if (!options.force && cached && Date.now() - cached.checkedAtMs < cacheMs) {
    return cached.status;
  }

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(CLI_PACKAGE_NAME)}/latest`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status}`);
    }
    const payload = (await response.json()) as { version?: unknown };
    const latestVersion = typeof payload.version === "string" ? payload.version : "";
    if (!latestVersion) {
      throw new Error("npm registry response did not include a version");
    }
    const checkedAt = new Date().toISOString();
    const comparison = compareVersions(CLI_VERSION, latestVersion);
    const status: UpdateStatus =
      comparison < 0
        ? {
            state: "available",
            currentVersion: CLI_VERSION,
            latestVersion,
            checkedAt,
            installCommand: `npm install -g ${CLI_PACKAGE_NAME}@latest`
          }
        : comparison > 0
        ? { state: "ahead", currentVersion: CLI_VERSION, latestVersion, checkedAt }
        : { state: "latest", currentVersion: CLI_VERSION, latestVersion, checkedAt };
    cached = { status, checkedAtMs: Date.now() };
    return status;
  } catch (error) {
    const status: UpdateStatus = {
      state: "unavailable",
      currentVersion: CLI_VERSION,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    };
    cached = { status, checkedAtMs: Date.now() };
    return status;
  }
}

export function renderUpdateStatus(status: UpdateStatus): string {
  if (status.state === "checking") {
    return "Checking for updates...";
  }
  if (status.state === "latest") {
    return `Thane CLI is up to date (${status.currentVersion}).`;
  }
  if (status.state === "ahead") {
    return `Thane CLI ${status.currentVersion} is newer than npm latest (${status.latestVersion}).`;
  }
  if (status.state === "available") {
    return `Thane CLI ${status.latestVersion} is available. You have ${status.currentVersion}.\nUpdate with: ${status.installCommand}`;
  }
  return `Could not check for updates: ${status.error}`;
}
