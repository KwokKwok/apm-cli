import http from "node:http";
import {
  AGENTS,
  findProvider,
  findProviderByRouteId,
  getActiveProvider,
  loadConfig,
} from "./config.js";
import { appendProxyLog } from "./logs.js";
import { APM_SERVICE_HEADER, APM_SERVICE_NAME } from "./runtime.js";

const AGENT_PROTOCOL = {
  codex: "openai",
  "claude-code": "anthropic",
};

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function shouldRetryStatus(status) {
  if (status === 429 || status === 408) return true;
  return status >= 500 && status <= 599;
}

function failoverCandidates(config, agent, baseProvider) {
  if (!baseProvider) return [];
  if (!config?.agents?.[agent]?.failover?.enabled) return [baseProvider];
  const sameAgentEnabled = config.agents[agent].providers
    .filter((provider) => provider?.failover?.enabled)
    .sort((a, b) => {
      const ao = a?.failover?.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b?.failover?.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });

  if (sameAgentEnabled.length === 0) return [baseProvider];
  if (sameAgentEnabled.some((provider) => provider.name === baseProvider.name)) {
    return sameAgentEnabled;
  }
  return [baseProvider, ...sameAgentEnabled];
}

function detectAgentFromRequest(req) {
  const explicit = req.headers["x-apm-agent"];
  if (typeof explicit === "string") {
    const value = explicit.toLowerCase();
    if (value === "codex") return "codex";
    if (value === "claude-code" || value === "claude" || value === "cc") {
      return "claude-code";
    }
  }
  const anthropicVersion = req.headers["anthropic-version"];
  if (typeof anthropicVersion === "string" && anthropicVersion.trim()) {
    return "claude-code";
  }
  const hasXApiKey = typeof req.headers["x-api-key"] === "string";
  const hasBearer = typeof req.headers.authorization === "string";
  if (hasXApiKey && !hasBearer) {
    return "claude-code";
  }
  const { strippedPath } = extractRouteFromPath(req.url || "/");
  const requestPath = pathOnly(strippedPath);
  if (requestPath.startsWith("/v1/messages")) {
    return "claude-code";
  }
  return "codex";
}

function pathOnly(rawPath) {
  const value = String(rawPath || "/");
  const qIdx = value.indexOf("?");
  return qIdx >= 0 ? value.slice(0, qIdx) : value;
}

function extractRouteFromPath(rawPath) {
  const routePath = String(rawPath || "/");
  const match = routePath.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/i);
  if (!match) {
    return { routeId: null, strippedPath: routePath };
  }
  return {
    routeId: match[1].toLowerCase(),
    strippedPath: match[2] || "/",
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRequestModel(body) {
  if (!body || body.length === 0) return null;
  const obj = safeJsonParse(body.toString("utf8"));
  if (!obj || typeof obj !== "object") return null;
  return typeof obj.model === "string" ? obj.model : null;
}

function extractUsageFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const usageSources = [
    obj.usage,
    obj.response?.usage,
    obj.result?.usage,
    obj.message?.usage,
  ];

  // Some providers put usage deeper (e.g. envelope/event payload variants).
  const seen = new Set();
  const stack = [obj];
  while (stack.length > 0 && usageSources.length < 64) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (cur.usage && typeof cur.usage === "object") {
      usageSources.push(cur.usage);
    }
    for (const value of Object.values(cur)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  const usage = usageSources.find((item) => item && typeof item === "object") || null;
  if (!usage) return null;

  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? null;
  const output = usage.output_tokens
    ?? usage.completion_tokens
    ?? usage.outputTokens
    ?? usage.text_output_tokens
    ?? null;
  const cacheRead = usage.cache_read_input_tokens
    ?? usage.cached_tokens
    ?? usage.cacheReadInputTokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? null;
  const cacheCreate = usage.cache_creation_input_tokens ?? usage.cacheCreateInputTokens ?? null;
  return {
    input: Number.isFinite(Number(input)) ? Number(input) : null,
    output: Number.isFinite(Number(output)) ? Number(output) : null,
    cache_read: Number.isFinite(Number(cacheRead)) ? Number(cacheRead) : null,
    cache_create: Number.isFinite(Number(cacheCreate)) ? Number(cacheCreate) : null,
  };
}

function extractUsageFromResponseText(text) {
  const payload = safeJsonParse(text);
  if (!payload) return null;
  const direct = extractUsageFromObject(payload);
  if (direct) return direct;
  if (Array.isArray(payload.data)) {
    for (const item of payload.data) {
      const u = extractUsageFromObject(item);
      if (u) return u;
    }
  }
  return null;
}

function extractUsageFromSse(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"));
  let latest = null;
  for (const line of lines) {
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const obj = safeJsonParse(data);
    if (!obj) continue;
    const usage = extractUsageFromObject(obj);
    if (usage) latest = usage;
  }
  return latest;
}

function hasContentPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  // Anthropic: delta.text on content_block_delta
  if (typeof obj.delta?.text === "string" && obj.delta.text.length > 0) return true;
  // OpenAI Responses: response.output_text.delta
  if (obj.type === "response.output_text.delta" && typeof obj.delta === "string" && obj.delta.length > 0) {
    return true;
  }
  // OpenAI: choices[0].delta.content
  const content = obj.choices?.[0]?.delta?.content;
  if (typeof content === "string" && content.length > 0) return true;
  // Some providers expose a top-level text delta
  if (typeof obj.text === "string" && obj.text.length > 0) return true;
  return false;
}

function computeTps(outputTokens, totalSec, ttftSec, isSse) {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
  const generationSec = isSse ? Math.max(0.001, totalSec - ttftSec) : Math.max(0.001, totalSec);
  return outputTokens / generationSec;
}

function buildClaudeVisibleModels() {
  return {
    object: "list",
    data: [
      { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
      { id: "claude-sonnet-4-5", object: "model", owned_by: "anthropic" },
      { id: "claude-opus-4-1", object: "model", owned_by: "anthropic" },
    ],
  };
}

function chooseProvider(config, req, agent) {
  const { routeId } = extractRouteFromPath(req.url || "/");
  if (routeId) {
    const routed = findProviderByRouteId(config, routeId);
    if (routed && routed.agent === agent) return routed;
  }

  const explicit = req.headers["x-apm-provider"];
  if (typeof explicit === "string") {
    const hit = findProvider(config, agent, explicit);
    if (hit) return hit;
  }

  return getActiveProvider(config, agent);
}

function joinTarget(baseUrl, incomingPath) {
  const base = trimSlash(baseUrl);
  const incoming = incomingPath || "/";
  if (base.endsWith("/v1") && incoming.startsWith("/v1/")) {
    return `${base}${incoming.slice(3)}`;
  }
  return `${base}${incoming}`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function resolveClaudeMappedModel(inputModel, provider) {
  const model = String(inputModel || "");
  const models = provider.models || {};
  if (/haiku/i.test(model)) return models.haiku || models.default || model;
  if (/opus/i.test(model)) return models.opus || models.default || model;
  if (/sonnet/i.test(model)) return models.sonnet || models.default || model;
  return models.default || model;
}

function maybeRewriteBodyForClaude(agent, provider, req, body) {
  if (agent !== "claude-code") {
    return body;
  }
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    return body;
  }
  if (!body || body.length === 0) {
    return body;
  }
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!payload || typeof payload !== "object" || typeof payload.model !== "string") {
    return body;
  }
  payload.model = resolveClaudeMappedModel(payload.model, provider);
  return Buffer.from(JSON.stringify(payload));
}

function copyHeaders(req, agent, provider) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers.authorization;
  delete headers["x-api-key"];

  const apiKey = provider.api_key || process.env[provider.api_key_env];
  if (agent === "codex") {
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  } else {
    if (apiKey) headers["x-api-key"] = apiKey;
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
  }
  return headers;
}

function handleApmHealth(req, res) {
  if (pathOnly(req.url || "/") !== "/__apm/health") return false;
  const body = JSON.stringify({
    ok: true,
    service: APM_SERVICE_NAME,
    version: "2",
    agents: AGENTS,
  });
  res.writeHead(200, {
    "content-type": "application/json",
    [APM_SERVICE_HEADER]: APM_SERVICE_NAME,
  });
  res.end(body);
  return true;
}

async function proxyRequest(req, res) {
  if (handleApmHealth(req, res)) return;

  const startedAt = Date.now();
  const config = loadConfig();
  const routed = extractRouteFromPath(req.url || "/");
  const agent = detectAgentFromRequest(req);
  const selected = chooseProvider(config, req, agent);

  if (!selected) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no active provider for ${agent}` }));
    return;
  }

  const body = await readRequestBody(req);
  const requestedModel = parseRequestModel(body);
  const candidates = failoverCandidates(config, agent, selected);

  if (
    agent === "claude-code" &&
    String(req.method || "GET").toUpperCase() === "GET" &&
    pathOnly(routed.strippedPath) === "/v1/models"
  ) {
    const payload = buildClaudeVisibleModels();
    const endedAt = Date.now();
    const totalMs = endedAt - startedAt;
    const totalSec = totalMs / 1000;
    appendProxyLog({
      ts: new Date(endedAt).toISOString(),
      phase: "done",
      agent,
      provider: selected?.name || null,
      model: null,
      status: 200,
      tokens: null,
      ttft: totalSec,
      tps: null,
      duration_ms: totalMs,
      path: routed.strippedPath,
      method: req.method || "GET",
      candidates: candidates.map((provider) => provider.name),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  appendProxyLog({
    ts: new Date(startedAt).toISOString(),
    phase: "start",
    agent,
    provider: selected?.name || null,
    model: requestedModel,
    upstream_model: null,
    status: null,
    tokens: null,
    ttft: null,
    tps: null,
    duration_ms: null,
    path: routed.strippedPath,
    method: req.method || "GET",
    candidates: candidates.map((provider) => provider.name),
  });

  let upstream = null;
  let lastError = null;
  let lastTarget = null;
  let usedProvider = null;
  let usedUpstreamModel = null;
  let firstByteAt = null;
  let responseBuffer = "";

  for (let i = 0; i < candidates.length; i += 1) {
    const provider = candidates[i];
    const targetUrl = joinTarget(provider.base_url, routed.strippedPath);
    const headers = copyHeaders(req, agent, provider);
    const outgoingBody = maybeRewriteBodyForClaude(agent, provider, req, body);
    const outgoingModel = parseRequestModel(outgoingBody);
    lastTarget = targetUrl;
    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: outgoingBody.length > 0 ? outgoingBody : undefined,
        redirect: "manual",
      });
      if (!response.ok && shouldRetryStatus(response.status) && i < candidates.length - 1) {
        lastError = new Error(`retryable upstream status ${response.status} from ${provider.name}`);
        continue;
      }
      upstream = response;
      usedProvider = provider;
      usedUpstreamModel = outgoingModel;
      break;
    } catch (error) {
      lastError = error;
      if (i === candidates.length - 1) break;
    }
  }

  if (!upstream) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "upstream request failed",
        message: lastError?.message || "unknown error",
        target: lastTarget,
      }),
    );
    return;
  }

  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-length") return;
    if (lower === "content-encoding") return;
    responseHeaders[key] = value;
  });
  res.writeHead(upstream.status, responseHeaders);

  if (!upstream.body) {
    const endedAt = Date.now();
    const totalMs = endedAt - startedAt;
    const totalSec = totalMs / 1000;
    appendProxyLog({
      ts: new Date(endedAt).toISOString(),
      phase: "done",
      agent,
      provider: usedProvider?.name || null,
      model: requestedModel,
      upstream_model: usedUpstreamModel,
      status: upstream.status,
      tokens: null,
      ttft: totalSec,
      tps: null,
      duration_ms: totalMs,
      path: routed.strippedPath,
    });
    res.end();
    return;
  }

  const contentType = String(upstream.headers.get("content-type") || "");
  const isSse = contentType.toLowerCase().includes("text/event-stream");

  let firstContentAt = null;
  let sseLineCarry = "";
  for await (const chunk of upstream.body) {
    if (firstByteAt == null) {
      firstByteAt = Date.now();
    }
    const chunkText = Buffer.from(chunk).toString("utf8");
    if (responseBuffer.length < 2_000_000) {
      responseBuffer += chunkText;
    }
    if (isSse && firstContentAt == null) {
      sseLineCarry += chunkText;
      const lines = sseLineCarry.split("\n");
      sseLineCarry = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const obj = safeJsonParse(data);
        if (obj && hasContentPayload(obj)) {
          firstContentAt = Date.now();
          break;
        }
      }
    }
    res.write(chunk);
  }
  res.end();

  const endedAt = Date.now();
  const totalMs = endedAt - startedAt;
  const totalSec = totalMs / 1000;
  const firstByteMs = firstByteAt == null ? totalMs : firstByteAt - startedAt;
  const ttftMs = isSse && firstContentAt != null
    ? firstContentAt - startedAt
    : firstByteMs;
  const ttft = ttftMs / 1000;
  const usage = isSse ? extractUsageFromSse(responseBuffer) : extractUsageFromResponseText(responseBuffer);
  const outputTokens = usage?.output ?? null;
  const tps = computeTps(outputTokens, totalSec, ttft, isSse);

  appendProxyLog({
    ts: new Date(endedAt).toISOString(),
    phase: "done",
    agent,
    provider: usedProvider?.name || null,
    model: requestedModel,
    upstream_model: usedUpstreamModel,
    status: upstream.status,
    tokens: usage,
    ttft,
    tps,
    duration_ms: totalMs,
    path: routed.strippedPath,
  });
}

export function startProxyServer({ host, port }) {
  const server = http.createServer((req, res) => {
    proxyRequest(req, res).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "proxy internal error",
          message: error?.message || String(error),
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}
