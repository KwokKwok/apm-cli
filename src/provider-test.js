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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, {
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

export async function testProvider(agent, provider, timeoutMs = 10_000, model = null) {
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

  if (!result.ok || !model) {
    return result;
  }

  if (!modelExistsInPayload(result.modelsPayload, model)) {
    return {
      ok: false,
      message: `connected but model not found: ${model}`,
    };
  }

  return {
    ok: true,
    message: `${result.message}, model=${model}`,
  };
}
