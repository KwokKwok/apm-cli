import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { getApmHome, ensureApmLayout } from "./config.js";

export const APM_SERVICE_HEADER = "x-apm-service";
export const APM_SERVICE_NAME = "apm-cli";

function runtimePath(fileName) {
  return path.join(getApmHome(), "runtime", fileName);
}

export function getProxyRuntimePath() {
  return runtimePath("proxy.json");
}

export function readProxyRuntime() {
  ensureApmLayout();
  const filePath = getProxyRuntimePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeProxyRuntime(runtime) {
  ensureApmLayout();
  fs.writeFileSync(getProxyRuntimePath(), JSON.stringify(runtime, null, 2) + "\n", "utf8");
}

export function clearProxyRuntime() {
  const filePath = getProxyRuntimePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function checkIfApmService(host, port) {
  const url = `http://${host}:${port}/__apm/health`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;

    const header = response.headers.get(APM_SERVICE_HEADER);
    if (header !== APM_SERVICE_NAME) return false;

    const data = await response.json().catch(() => null);
    return Boolean(
      data &&
      data.service === APM_SERVICE_NAME &&
      data.ok === true,
    );
  } catch {
    return false;
  }
}

export async function checkPortAndService(host, port) {
  const available = await checkPortAvailable(host, port);
  if (available) {
    return { available: true, isApmService: false };
  }

  const isApm = await checkIfApmService(host, port);
  return { available: false, isApmService: isApm };
}
