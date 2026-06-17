import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApmHome, ensureApmLayout } from "./config.js";
import {
  readJson,
  writeJson,
  readText,
  writeText,
  isEmptyObject,
  sectionRegex,
  APM_API_KEY,
} from "./utils.js";

function apmBackupsPath() {
  return path.join(getApmHome(), "backups");
}

function apmBackupPath(agent, fileName) {
  return path.join(apmBackupsPath(), agent, fileName);
}

function takeoverStatePath() {
  return path.join(getApmHome(), "runtime", "takeover.json");
}

function readTakeoverState() {
  const filePath = takeoverStatePath();
  return readJson(filePath, { codex: false, claude: false });
}

function writeTakeoverState(state) {
  ensureApmLayout();
  const filePath = takeoverStatePath();
  writeJson(filePath, state);
}

function codexPaths() {
  const root = path.join(os.homedir(), ".codex");
  return {
    root,
    authPath: path.join(root, "auth.json"),
    configPath: path.join(root, "config.toml"),
  };
}

function claudePaths() {
  const root = path.join(os.homedir(), ".claude");
  return {
    root,
    settingsPath: path.join(root, "settings.json"),
  };
}

function userBackupPath(filePath) {
  return `${filePath}.apm.bak`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readModelProviderValue(text) {
  const match = String(text || "").match(/^\s*model_provider\s*=\s*"(.*?)"\s*$/m);
  return match?.[1]?.trim() || null;
}

function backupToBothLocations(sourcePath, agent, fileName) {
  if (!fs.existsSync(sourcePath)) return null;

  const content = fs.readFileSync(sourcePath, "utf8");

  const userBackup = userBackupPath(sourcePath);
  fs.copyFileSync(sourcePath, userBackup);

  const apmBackup = apmBackupPath(agent, fileName);
  ensureDir(path.dirname(apmBackup));
  fs.writeFileSync(apmBackup, content, "utf8");

  return content;
}

export function enableCodexTakeover(proxyOrigin) {
  ensureApmLayout();
  const { authPath, configPath } = codexPaths();
  const state = readTakeoverState();
  const alreadyEnabled = Boolean(state.codex);

  if (!alreadyEnabled) {
    backupToBothLocations(authPath, "codex", "auth.json");
  }
  const configOriginal = alreadyEnabled
    ? null
    : backupToBothLocations(configPath, "codex", "config.toml");
  const originalModelProvider = alreadyEnabled
    ? state.codex?.originalModelProvider ?? null
    : configOriginal
      ? readModelProviderValue(configOriginal)
      : null;

  const auth = readJson(authPath, {});
  auth.OPENAI_API_KEY = APM_API_KEY;
  writeJson(authPath, auth);

  const proxyBaseV1 = `${proxyOrigin.replace(/\/+$/, "")}/v1`;
  let configText = readText(configPath, "");

  configText = configText.replace(sectionRegex("apm"), "\n");
  configText = configText.replace(sectionRegex("model_providers.apm"), "\n");

  if (/^\s*model_provider\s*=.*$/m.test(configText)) {
    configText = configText.replace(/^\s*model_provider\s*=.*$/m, 'model_provider = "apm"');
  } else {
    configText = `model_provider = "apm"\n${configText}`;
  }
  configText = configText.replace(/^\s*base_url\s*=\s*".*?"\s*$(\r?\n)?/gm, "");

  configText = `${configText.trimEnd()}

[model_providers.apm]
name = "apm"
base_url = "${proxyBaseV1}"
wire_api = "responses"
requires_openai_auth = true
`;
  writeText(configPath, configText);

  state.codex = {
    ...(alreadyEnabled && typeof state.codex === "object" ? state.codex : {}),
    originalModelProvider,
    enabledAt: state.codex?.enabledAt || new Date().toISOString(),
    refreshedAt: alreadyEnabled ? new Date().toISOString() : undefined,
  };
  writeTakeoverState(state);

  return { authPath, configPath };
}

export function disableCodexTakeover() {
  const { authPath, configPath } = codexPaths();
  const apmAuthBackup = apmBackupPath("codex", "auth.json");
  const apmConfigBackup = apmBackupPath("codex", "config.toml");
  const state = readTakeoverState();

  if (fs.existsSync(apmAuthBackup)) {
    const originalAuth = fs.readFileSync(apmAuthBackup, "utf8");
    if (originalAuth.trim()) {
      writeText(authPath, originalAuth);
    } else if (fs.existsSync(authPath)) {
      fs.unlinkSync(authPath);
    }
  } else {
    const auth = readJson(authPath, {});
    if (auth.OPENAI_API_KEY === APM_API_KEY) {
      delete auth.OPENAI_API_KEY;
      if (isEmptyObject(auth)) {
        fs.unlinkSync(authPath);
      } else {
        writeJson(authPath, auth);
      }
    }
  }

  if (fs.existsSync(apmConfigBackup)) {
    writeText(configPath, fs.readFileSync(apmConfigBackup, "utf8"));
  } else {
    let configText = readText(configPath, "");

    configText = configText.replace(sectionRegex("apm"), "\n");
    configText = configText.replace(sectionRegex("model_providers.apm"), "\n");
    configText = configText.replace(/^\s*model_provider\s*=\s*"apm"\s*$/m, "");

    if (state.codex?.originalModelProvider) {
      if (/^\s*model_provider\s*=.*$/m.test(configText)) {
        configText = configText.replace(
          /^\s*model_provider\s*=.*$/m,
          `model_provider = "${state.codex.originalModelProvider}"`,
        );
      } else {
        configText = `model_provider = "${state.codex.originalModelProvider}"\n${configText}`;
      }
    }

    configText = configText.trim();
    if (!configText) {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } else {
      writeText(configPath, `${configText}\n`);
    }
  }

  const newState = readTakeoverState();
  newState.codex = false;
  writeTakeoverState(newState);

  return { authPath, configPath };
}

export function enableClaudeTakeover(proxyOrigin) {
  ensureApmLayout();
  const { settingsPath } = claudePaths();
  const state = readTakeoverState();
  const alreadyEnabled = Boolean(state.claude);

  const settingsOriginal = alreadyEnabled
    ? null
    : backupToBothLocations(settingsPath, "claude", "settings.json");
  const originalBaseUrl = settingsOriginal
    ? JSON.parse(settingsOriginal).env?.ANTHROPIC_BASE_URL
    : state.claude?.originalBaseUrl ?? null;

  const settings = readJson(settingsPath, {});
  const env = { ...(settings.env || {}) };

  env.ANTHROPIC_BASE_URL = proxyOrigin;

  if (env.ANTHROPIC_API_KEY === APM_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
  }
  if (!env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = APM_API_KEY;
  }

  settings.env = env;
  writeJson(settingsPath, settings);

  state.claude = {
    ...(alreadyEnabled && typeof state.claude === "object" ? state.claude : {}),
    originalBaseUrl,
    enabledAt: state.claude?.enabledAt || new Date().toISOString(),
    refreshedAt: alreadyEnabled ? new Date().toISOString() : undefined,
  };
  writeTakeoverState(state);

  return { settingsPath };
}

export function disableClaudeTakeover() {
  const { settingsPath } = claudePaths();
  const apmBackup = apmBackupPath("claude", "settings.json");
  const state = readTakeoverState();

  if (fs.existsSync(apmBackup)) {
    const originalSettings = fs.readFileSync(apmBackup, "utf8");
    if (originalSettings.trim()) {
      writeText(settingsPath, originalSettings);
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
  } else {
    const settings = readJson(settingsPath, {});
    const env = { ...(settings.env || {}) };

    if (env.ANTHROPIC_BASE_URL?.startsWith("http://127.0.0.1:") ||
        env.ANTHROPIC_BASE_URL?.startsWith("http://localhost:")) {
      delete env.ANTHROPIC_BASE_URL;
    }

    if (env.ANTHROPIC_AUTH_TOKEN === APM_API_KEY) {
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    if (env.ANTHROPIC_API_KEY === APM_API_KEY) {
      delete env.ANTHROPIC_API_KEY;
    }

    if (Object.keys(env).length === 0) {
      delete settings.env;
    } else {
      settings.env = env;
    }

    if (isEmptyObject(settings)) {
      if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    } else {
      writeJson(settingsPath, settings);
    }
  }

  const newState = readTakeoverState();
  newState.claude = false;
  writeTakeoverState(newState);

  return { settingsPath };
}

export function resetCodexToOAuth() {
  const { authPath, configPath } = codexPaths();

  const auth = readJson(authPath, null);
  if (auth && typeof auth === "object" && Object.hasOwn(auth, "OPENAI_API_KEY")) {
    delete auth.OPENAI_API_KEY;
    if (isEmptyObject(auth)) {
      fs.unlinkSync(authPath);
    } else {
      writeJson(authPath, auth);
    }
  }

  let configText = readText(configPath, "");
  configText = configText.replace(/^\s*model_provider\s*=\s*".*?"\s*$/m, "");
  configText = configText.replace(/^\s*preferred_auth_method\s*=\s*".*?"\s*$/m, "");
  configText = configText.replace(sectionRegex("model_providers.apm"), "\n");
  configText = configText.replace(/\[model_providers\]\s*\n/g, "");
  configText = configText.trim();
  if (configText) {
    writeText(configPath, `${configText}\n`);
  } else if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }

  return { authPath, configPath };
}

export function getTakeoverState() {
  return readTakeoverState();
}
