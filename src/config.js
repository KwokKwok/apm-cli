import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

export const AGENTS = ["codex", "claude-code"];

const DEFAULT_PROVIDER = {
  name: "",
  base_url: "",
  api_key_env: "",
  models: {
    default: null,
    sonnet: null,
    opus: null,
    haiku: null,
  },
  failover: {
    enabled: false,
    order: null,
  },
};

const DEFAULT_CONFIG = {
  version: 2,
  server: {
    host: "127.0.0.1",
    port: 4891,
  },
  agents: {
    codex: {
      protocol: "openai",
      active: null,
      failover: {
        enabled: false,
      },
      providers: [],
    },
    "claude-code": {
      protocol: "anthropic",
      active: null,
      failover: {
        enabled: false,
      },
      providers: [],
    },
  },
};

export function normalizeAgent(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === "codex") return "codex";
  if (value === "claude-code" || value === "claude" || value === "cc") {
    return "claude-code";
  }
  return null;
}

export function getApmHome() {
  return path.join(os.homedir(), ".apm");
}

export function getApmConfigPath() {
  return path.join(getApmHome(), "config.yaml");
}

export function ensureApmLayout() {
  const apmHome = getApmHome();
  fs.mkdirSync(apmHome, { recursive: true });
  fs.mkdirSync(path.join(apmHome, "providers"), { recursive: true });
  fs.mkdirSync(path.join(apmHome, "backups"), { recursive: true });
  fs.mkdirSync(path.join(apmHome, "runtime"), { recursive: true });
}

function normalizeProvider(raw) {
  return {
    ...DEFAULT_PROVIDER,
    ...raw,
    name: String(raw?.name || "").trim(),
    base_url: String(raw?.base_url || "").trim(),
    api_key_env: String(raw?.api_key_env || "").trim(),
    models: {
      ...DEFAULT_PROVIDER.models,
      ...(raw?.models || {}),
    },
    failover: {
      enabled: Boolean(raw?.failover?.enabled),
      order: Number.isInteger(raw?.failover?.order) ? raw.failover.order : null,
    },
  };
}

function normalizeAgentPool(rawPool, fallbackProtocol, legacyGlobalFailoverEnabled = false) {
  const providers = Array.isArray(rawPool?.providers)
    ? rawPool.providers.map(normalizeProvider).filter((p) => p.name)
    : [];
  const active = typeof rawPool?.active === "string" ? rawPool.active : null;
  return {
    protocol: rawPool?.protocol || fallbackProtocol,
    active,
    failover: {
      enabled: typeof rawPool?.failover?.enabled === "boolean"
        ? rawPool.failover.enabled
        : Boolean(legacyGlobalFailoverEnabled),
    },
    providers,
  };
}

function normalizeConfig(parsed) {
  const legacyGlobalFailoverEnabled = Boolean(parsed?.failover?.enabled);
  return {
    version: 2,
    server: {
      ...DEFAULT_CONFIG.server,
      ...(parsed?.server || {}),
    },
    agents: {
      codex: normalizeAgentPool(parsed?.agents?.codex, "openai", legacyGlobalFailoverEnabled),
      "claude-code": normalizeAgentPool(
        parsed?.agents?.["claude-code"],
        "anthropic",
        legacyGlobalFailoverEnabled,
      ),
    },
  };
}

export function loadConfig() {
  ensureApmLayout();
  const configPath = getApmConfigPath();
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parse(raw) || {};
  return normalizeConfig(parsed);
}

export function saveConfig(config) {
  ensureApmLayout();
  fs.writeFileSync(getApmConfigPath(), stringify(normalizeConfig(config)), "utf8");
}

export function getAgentConfig(config, agent) {
  const normalized = normalizeAgent(agent);
  if (!normalized) return null;
  return config.agents[normalized] || null;
}

export function listProviders(config, agent) {
  const pool = getAgentConfig(config, agent);
  return pool ? pool.providers : [];
}

export function findProvider(config, agent, name) {
  const providers = listProviders(config, agent);
  return providers.find((provider) => provider.name === name) || null;
}

export function providerRouteId(agent, name) {
  const normalizedAgent = normalizeAgent(agent);
  const agentPrefix = normalizedAgent === "codex" ? "cx" : "cc";
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `${agentPrefix}-${slug}`;
}

export function findProviderByRouteId(config, routeId) {
  const id = String(routeId || "").trim().toLowerCase();
  if (!id) return null;

  for (const agent of AGENTS) {
    for (const provider of config.agents[agent].providers) {
      if (providerRouteId(agent, provider.name) === id) {
        return { ...provider, agent };
      }
    }
  }
  return null;
}

export function getActiveProvider(config, agent) {
  const pool = getAgentConfig(config, agent);
  if (!pool || !pool.active) return null;
  return findProvider(config, agent, pool.active);
}
