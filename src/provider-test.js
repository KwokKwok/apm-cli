function redact(value) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

async function testCodexProvider(provider, timeoutMs) {
  const apiKey = provider.api_key || process.env[provider.api_key_env];
  if (!apiKey) {
    return {
      ok: false,
      message: `missing env ${provider.api_key_env}`,
    };
  }
  const base = provider.base_url.replace(/\/+$/, "");
  const modelsPath = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(modelsPath, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        message: `status ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      };
    }
    const bodyText = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
    return {
      ok: true,
      message: `connected (${provider.base_url}, key=${redact(apiKey)})`,
      modelsPayload: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testClaudeCodeProvider(provider, timeoutMs) {
  const apiKey = provider.api_key || process.env[provider.api_key_env];
  if (!apiKey) {
    return {
      ok: false,
      message: `missing env ${provider.api_key_env}`,
    };
  }
  const base = provider.base_url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/models`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Authorization": `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        message: `status ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      };
    }
    const bodyText = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
    return {
      ok: true,
      message: `connected (${provider.base_url}, key=${redact(apiKey)})`,
      modelsPayload: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function modelExistsInPayload(payload, model) {
  if (!payload || !model) return true;
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.some((item) => {
    const id = item?.id;
    return typeof id === "string" && id === model;
  });
}

async function runInferenceTest({ base, apiKey, model, agent, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url =
    agent === "codex"
      ? base.endsWith("/v1")
        ? `${base}/responses`
        : `${base}/v1/responses`
      : `${base}/v1/messages`;
  const body =
    agent === "codex"
      ? { model, input: "你好", max_output_tokens: 16 }
      : {
          model,
          max_tokens: 16,
          system: "你是一个测试助手。",
          messages: [{ role: "user", content: "你好" }],
        };
  const headers = { "Content-Type": "application/json" };
  if (agent === "codex") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        message: `status ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const sample = extractInferenceSample(parsed, agent);
    if (!sample) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        message: `no text in response (content-type=${res.headers.get("content-type") || "?"}, body=${text.slice(0, 200)})`,
      };
    }
    return {
      ok: true,
      latencyMs,
      model: parsed?.model || model,
      sample,
      raw: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractInferenceSample(payload, agent) {
  if (!payload) return null;
  if (agent === "codex") {
    const output = Array.isArray(payload.output) ? payload.output : [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const block of content) {
        if (block?.type === "output_text" && typeof block.text === "string") {
          return block.text;
        }
      }
    }
    return null;
  }
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

export async function testProvider(agent, provider, timeoutMs = 10_000, model = null, inference = false) {
  let result;
  if (agent === "codex") {
    result = await testCodexProvider(provider, timeoutMs);
  } else if (agent === "claude-code") {
    result = await testClaudeCodeProvider(provider, timeoutMs);
  } else {
    return {
      ok: false,
      message: `unsupported agent ${agent}`,
    };
  }

  if (!result.ok) {
    return result;
  }

  if (model && !modelExistsInPayload(result.modelsPayload, model)) {
    return {
      ok: false,
      message: `connected but model not found: ${model}`,
    };
  }

  if (!inference) {
    return {
      ok: true,
      message: model ? `${result.message}, model=${model}` : result.message,
    };
  }

  const targetModel = model || provider.models?.default;
  if (!targetModel) {
    return {
      ok: false,
      message: `${result.message}; inference skipped: no model configured`,
      modelsPayload: result.modelsPayload,
    };
  }

  const apiKey = provider.api_key || process.env[provider.api_key_env];
  const base = provider.base_url.replace(/\/+$/, "");
  const inf = await runInferenceTest({ base, apiKey, model: targetModel, agent, timeoutMs });
  const sample = inf.sample ? ` sample=${JSON.stringify(inf.sample.slice(0, 80))}` : "";
  const status = inf.ok
    ? `, model=${inf.model}, ${inf.latencyMs}ms${sample}`
    : `, inference failed: ${inf.message}`;

  return {
    ok: inf.ok,
    message: `${result.message}${status}`,
    modelsPayload: result.modelsPayload,
    inference: inf,
  };
}
