import fs from "node:fs";
import path from "node:path";
import { getApmHome, ensureApmLayout, loadConfig, providerRouteId } from "./config.js";
import {
  readJsonIfExists,
  isEmptyObject,
  sectionRegex,
  APM_API_KEY,
} from "./utils.js";

function runtimePath(fileName) {
  return path.join(getApmHome(), "runtime", fileName);
}

function bindingsPath() {
  return runtimePath("bindings.json");
}

function readBindings() {
  ensureApmLayout();
  const filePath = bindingsPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeBindings(bindings) {
  ensureApmLayout();
  fs.writeFileSync(bindingsPath(), JSON.stringify(bindings, null, 2) + "\n", "utf8");
}

function findProjectRoot(startDir) {
  return path.resolve(startDir);
}

export function hasProjectRootMarker(startDir) {
  const current = findProjectRoot(startDir);
  const markers = [
    path.join(current, ".git"),
    path.join(current, "package.json"),
    path.join(current, ".claude"),
    path.join(current, ".codex"),
  ];
  return markers.some((markerPath) => fs.existsSync(markerPath));
}

function getDefaultPort() {
  try {
    const config = loadConfig();
    return config?.server?.port || 4891;
  } catch {
    return 4891;
  }
}

export function isApmProxyUrl(url, config) {
  if (!url) return false;
  const port = config?.server?.port || getDefaultPort();
  const pattern = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}(/|$)`);
  return pattern.test(url);
}

export function readLocalBinding(cwd, agent) {
  const projectRoot = findProjectRoot(cwd);

  if (agent === "codex") {
    const configPath = path.join(projectRoot, ".codex", "config.toml");
    return readCodexLocalBinding(configPath, projectRoot);
  }

  const localPath = resolveClaudeProjectSettingsPath(projectRoot);
  return readClaudeLocalBinding(localPath, projectRoot);
}

function resolveClaudeProjectSettingsPath(projectRoot) {
  const canonicalPath = path.join(projectRoot, ".claude", "settings.local.json");
  if (fs.existsSync(canonicalPath)) return canonicalPath;

  // Backward compatibility for old apm versions.
  const legacyPath = path.join(projectRoot, ".claude", "settings.json");
  if (fs.existsSync(legacyPath)) return legacyPath;
  return canonicalPath;
}

function readClaudeLocalBinding(localPath, projectRoot) {
  const local = readJsonIfExists(localPath);
  const baseUrl = local?.env?.ANTHROPIC_BASE_URL;

  let config;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }
  const isProxy = isApmProxyUrl(baseUrl, config);

  return {
    projectRoot,
    scope: "local",
    localPath,
    exists: fs.existsSync(localPath),
    isApmProxy: isProxy,
    routeId: isProxy ? extractRouteId(baseUrl) : null,
  };
}

function readCodexLocalBinding(configPath, projectRoot) {
  if (!fs.existsSync(configPath)) {
    return {
      projectRoot,
      scope: "none",
      configPath,
      exists: false,
      isApmProxy: false,
      routeId: null,
    };
  }

  const text = fs.readFileSync(configPath, "utf8");
  const baseUrl = extractCodexApmBaseUrl(text);

  let config;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }
  const isProxy = isApmProxyUrl(baseUrl, config);

  return {
    projectRoot,
    scope: "local",
    configPath,
    exists: true,
    isApmProxy: isProxy,
    routeId: isProxy ? extractRouteId(baseUrl) : null,
  };
}

function extractRouteId(url) {
  if (!url) return null;
  const match = String(url).match(/\/p\/([a-z0-9-]+)(?:\/|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function extractCodexApmBaseUrl(text) {
  const block = text.match(/\n?\s*\[model_providers\.apm\]\s*([\s\S]*?)(?=\n\s*\[|$)/);
  if (!block || !block[1]) return null;
  const match = block[1].match(/^\s*base_url\s*=\s*"(.*?)"\s*$/m);
  return match?.[1] || null;
}

function cleanupCodexApmFields(text) {
  let next = text;
  next = next.replace(sectionRegex("apm"), "\n");
  next = next.replace(sectionRegex("model_providers.apm"), "\n");
  next = next.replace(/^\s*model_provider\s*=\s*"apm"\s*$/m, "");
  next = next.replace(/^\s*base_url\s*=\s*".*?"\s*$(\r?\n)?/gm, "");
  return next.trim();
}

export function writeLocalBinding({ cwd, provider, agent, proxyOrigin }) {
  const projectRoot = findProjectRoot(cwd);
  const routeId = providerRouteId(agent, provider);
  const normalizedOrigin = String(proxyOrigin || "").replace(/\/+$/, "");
  const bindings = readBindings();

  if (agent === "codex") {
    throw new Error("codex does not support project-level custom providers");
  }

  const claudeDir = path.join(projectRoot, ".claude");
  const localPath = path.join(claudeDir, "settings.local.json");
  fs.mkdirSync(claudeDir, { recursive: true });

  const existed = fs.existsSync(localPath);
  const originalSnapshot = existed ? fs.readFileSync(localPath, "utf8") : null;

  const current = readJsonIfExists(localPath) || {};
  const env = { ...(current.env || {}) };
  env.ANTHROPIC_BASE_URL = `${normalizedOrigin}/p/${routeId}`;

  if (env.ANTHROPIC_API_KEY === APM_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
  }
  if (!env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = APM_API_KEY;
  }

  const next = { ...current, env };
  fs.writeFileSync(localPath, JSON.stringify(next, null, 2) + "\n", "utf8");

  bindings[projectRoot] = bindings[projectRoot] || {};
  bindings[projectRoot].claude = {
    localPath,
    createdByApm: !existed,
    originalSnapshot,
    writtenAt: new Date().toISOString(),
  };
  writeBindings(bindings);

  return { projectRoot, localPath, routeId };
}

function upsertCodexProxyUrl(configPath, proxyUrl) {
  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";

  if (!existing.trim()) {
    const next = `model_provider = "apm"
model = "gpt-5.3-codex"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.apm]
name = "apm"
base_url = "${proxyUrl}"
wire_api = "responses"
requires_openai_auth = true
`;
    fs.writeFileSync(configPath, next, "utf8");
    return;
  }

  let next = existing;
  next = next.replace(sectionRegex("apm"), "\n");
  next = next.replace(sectionRegex("model_providers.apm"), "\n");
  if (/^\s*model_provider\s*=.*$/m.test(next)) {
    next = next.replace(/^\s*model_provider\s*=.*$/m, 'model_provider = "apm"');
  } else {
    next = `model_provider = "apm"\n${next}`;
  }
  next = next.replace(/^\s*base_url\s*=\s*".*?"\s*$(\r?\n)?/gm, "");
  next = `${next.trimEnd()}

[model_providers.apm]
name = "apm"
base_url = "${proxyUrl}"
wire_api = "responses"
requires_openai_auth = true
`;
  fs.writeFileSync(configPath, next, "utf8");
}

export function cleanupLocalBinding(cwd, agent) {
  const projectRoot = findProjectRoot(cwd);
  const bindings = readBindings();
  const projectBindings = bindings[projectRoot];
  if (!projectBindings || !projectBindings[agent]) {
    return cleanupUnregisteredLocalBinding(projectRoot, agent);
  }

  const binding = projectBindings[agent];
  const { localPath, createdByApm, originalSnapshot } = binding;

  let deleted = false;

  if (createdByApm && fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
    if (agent === "claude-code") {
      cleanupEmptyClaudeDir(localPath);
    }
    deleted = true;
  } else if (!createdByApm && originalSnapshot !== null) {
    if (agent === "codex") {
      cleanupAndMaybeDeleteCodex(localPath, originalSnapshot);
    } else {
      cleanupAndMaybeDeleteClaude(localPath, originalSnapshot);
    }
    deleted = true;
  }

  delete projectBindings[agent];
  if (Object.keys(projectBindings).length === 0) {
    delete bindings[projectRoot];
  }
  writeBindings(bindings);

  return { cleaned: true, deleted, localPath };
}

function cleanupUnregisteredLocalBinding(projectRoot, agent) {
  if (agent === "claude-code") {
    const candidates = [
      path.join(projectRoot, ".claude", "settings.local.json"),
      path.join(projectRoot, ".claude", "settings.json"),
    ];
    for (const localPath of candidates) {
      if (!fs.existsSync(localPath)) continue;
      const before = readJsonIfExists(localPath);
      if (!before) continue;
      const env = { ...(before.env || {}) };
      const hasApmTrace = isApmProxyUrl(env.ANTHROPIC_BASE_URL, null)
        || env.ANTHROPIC_AUTH_TOKEN === APM_API_KEY
        || env.ANTHROPIC_API_KEY === APM_API_KEY;
      if (!hasApmTrace) continue;
      cleanupAndMaybeDeleteClaude(localPath, null);
      return { cleaned: true, deleted: true, localPath, fallback: true };
    }
    return { cleaned: false, reason: "not registered" };
  }

  if (agent === "codex") {
    const configPath = path.join(projectRoot, ".codex", "config.toml");
    if (!fs.existsSync(configPath)) {
      return { cleaned: false, reason: "not registered" };
    }
    const current = fs.readFileSync(configPath, "utf8");
    const cleaned = cleanupCodexApmFields(current);
    if (cleaned === current.trim()) {
      return { cleaned: false, reason: "not registered" };
    }
    if (!cleaned) {
      fs.unlinkSync(configPath);
    } else {
      fs.writeFileSync(configPath, `${cleaned}\n`, "utf8");
    }
    return { cleaned: true, deleted: true, localPath: configPath, fallback: true };
  }

  return { cleaned: false, reason: "not registered" };
}

function cleanupAndMaybeDeleteClaude(localPath, originalSnapshot) {
  const current = readJsonIfExists(localPath);
  if (!current) return;

  const env = { ...(current.env || {}) };
  const original = originalSnapshot ? JSON.parse(originalSnapshot) : {};
  const originalEnv = original.env || {};

  if (isApmProxyUrl(env.ANTHROPIC_BASE_URL, null)) {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (env.ANTHROPIC_AUTH_TOKEN === APM_API_KEY) {
    if (!originalEnv.ANTHROPIC_AUTH_TOKEN) {
      delete env.ANTHROPIC_AUTH_TOKEN;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = originalEnv.ANTHROPIC_AUTH_TOKEN;
    }
  }
  if (env.ANTHROPIC_API_KEY === APM_API_KEY) {
    if (!originalEnv.ANTHROPIC_API_KEY) {
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    }
  }

  if (Object.keys(env).length === 0) {
    delete current.env;
  } else {
    current.env = env;
  }

  if (isEmptyObject(current)) {
    fs.unlinkSync(localPath);
    cleanupEmptyClaudeDir(localPath);
  } else {
    fs.writeFileSync(localPath, JSON.stringify(current, null, 2) + "\n", "utf8");
  }
}

function cleanupEmptyClaudeDir(localPath) {
  const dir = path.dirname(localPath);
  const base = path.basename(dir);
  if (base !== ".claude") return;
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore cleanup failures
  }
}

function cleanupAndMaybeDeleteCodex(configPath) {
  const current = fs.readFileSync(configPath, "utf8");
  const cleaned = cleanupCodexApmFields(current);

  if (!cleaned) {
    fs.unlinkSync(configPath);
  } else {
    fs.writeFileSync(configPath, `${cleaned}\n`, "utf8");
  }
}

export function getAllBindings() {
  return readBindings();
}

export function clearAllBindings() {
  writeBindings({});
}

export function renameLocalRouteReferences(agent, oldRouteId, newRouteId) {
  if (agent !== "claude-code") return { updated: 0 };
  const oldId = String(oldRouteId || "").trim().toLowerCase();
  const newId = String(newRouteId || "").trim().toLowerCase();
  if (!oldId || !newId || oldId === newId) return { updated: 0 };

  const bindings = readBindings();
  let updated = 0;
  for (const projectRoot of Object.keys(bindings)) {
    const claude = bindings[projectRoot]?.claude;
    const localPath = claude?.localPath;
    if (!localPath || !fs.existsSync(localPath)) continue;
    const json = readJsonIfExists(localPath);
    if (!json?.env?.ANTHROPIC_BASE_URL) continue;
    const prev = String(json.env.ANTHROPIC_BASE_URL);
    const next = prev.replace(
      new RegExp(`/p/${oldId}(?=/|$)`, "i"),
      `/p/${newId}`,
    );
    if (next === prev) continue;
    json.env.ANTHROPIC_BASE_URL = next;
    fs.writeFileSync(localPath, JSON.stringify(json, null, 2) + "\n", "utf8");
    updated += 1;
  }
  return { updated };
}
