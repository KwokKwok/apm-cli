import { execFileSync } from "node:child_process";

function slugify(input) {
  return String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function parseJsonSafe(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseCodexConfig(configText) {
  const text = String(configText || "");
  const baseMatch = text.match(/^\s*base_url\s*=\s*"(.*?)"\s*$/m);
  const modelMatch = text.match(/^\s*model\s*=\s*"(.*?)"\s*$/m);
  return {
    baseUrl: baseMatch ? baseMatch[1] : null,
    model: modelMatch ? modelMatch[1] : null,
  };
}

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function mapRowToProvider(row) {
  const settings = parseJsonSafe(row.settings_config || "{}", {});
  if (!settings || typeof settings !== "object") return null;

  const app = String(row.app_type || "").trim();
  const rawName = String(row.name || "").trim();
  if (!rawName) return null;

  if (app === "codex") {
    const configText = settings?.config || "";
    const { baseUrl, model } = parseCodexConfig(configText);
    const apiKey = settings?.auth?.OPENAI_API_KEY || null;
    if (!baseUrl) return null;
    return {
      source_id: row.id || null,
      agent: "codex",
      name: rawName,
      base_url: normalizeBaseUrl(baseUrl),
      api_key_env: `APM_IMPORTED_${slugify(rawName)}_OPENAI_API_KEY`,
      api_key: apiKey,
      models: {
        default: model,
        sonnet: null,
        opus: null,
        haiku: null,
      },
      in_failover_queue: Number(row.in_failover_queue) === 1,
    };
  }

  if (app === "claude") {
    const env = settings?.env || {};
    const baseUrl = env.ANTHROPIC_BASE_URL || null;
    const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || null;
    if (!baseUrl) return null;
    return {
      source_id: row.id || null,
      agent: "claude-code",
      name: rawName,
      base_url: normalizeBaseUrl(baseUrl),
      api_key_env: `APM_IMPORTED_${slugify(rawName)}_ANTHROPIC_API_KEY`,
      api_key: apiKey,
      models: {
        default: env.ANTHROPIC_MODEL || null,
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null,
      },
      in_failover_queue: Number(row.in_failover_queue) === 1,
    };
  }

  return null;
}

function normalizeFailoverOrder(pool) {
  const queue = pool.providers
    .filter((provider) => provider?.failover?.enabled)
    .sort((a, b) => {
      const ao = a?.failover?.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b?.failover?.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });

  queue.forEach((provider, index) => {
    provider.failover.order = index + 1;
  });

  for (const provider of pool.providers) {
    if (!provider.failover?.enabled) {
      provider.failover.order = null;
    }
  }
}

function upsertImportedProvider(config, incoming) {
  const pool = config.agents[incoming.agent];
  const existingIndex = pool.providers.findIndex(
    (provider) => provider.name.toLowerCase() === incoming.name.toLowerCase(),
  );

  const providerRecord = {
    name: incoming.name,
    base_url: incoming.base_url,
    api_key_env: incoming.api_key_env,
    api_key: incoming.api_key || null,
    models: incoming.models,
    failover: {
      enabled: incoming.in_failover_queue,
      order: null,
    },
    imported_from: "cc-switch",
    imported_source_id: incoming.source_id,
  };

  if (existingIndex >= 0) {
    pool.providers[existingIndex] = providerRecord;
    return { created: false, updated: true };
  }
  pool.providers.push(providerRecord);
  if (!pool.active) {
    pool.active = incoming.name;
  }
  return { created: true, updated: false };
}

export function importFromCcSwitch(config, dbPath, targetAgent = "all") {
  const sql = `
    SELECT id,name,app_type,settings_config,sort_index,in_failover_queue,created_at
    FROM providers
    WHERE app_type IN ('claude','codex')
    ORDER BY app_type, (sort_index IS NULL), sort_index, created_at, id
  `;

  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });
  const rows = parseJsonSafe(out || "[]", []);
  const mapped = Array.isArray(rows) ? rows.map(mapRowToProvider).filter(Boolean) : [];

  const selected = targetAgent === "all"
    ? mapped
    : mapped.filter((item) => item.agent === targetAgent);

  let imported = 0;
  let updated = 0;
  for (const incoming of selected) {
    const result = upsertImportedProvider(config, incoming);
    if (result.created) imported += 1;
    if (result.updated) updated += 1;
  }

  normalizeFailoverOrder(config.agents.codex);
  normalizeFailoverOrder(config.agents["claude-code"]);

  return {
    imported,
    updated,
    totalScanned: mapped.length,
    applied: selected.length,
    targetAgent,
  };
}
