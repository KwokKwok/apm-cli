import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const host = "127.0.0.1";

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
  });
}

function startMockUpstream({ port }) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/responses" || req.url === "/v1/responses")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            usage: {
              input_tokens: 120,
              output_tokens: 40,
              cached_tokens: 10,
            },
          },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

test("goal: codex SSE usage is extracted from response.usage and produces tps", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-codex-usage-"));
  process.env.HOME = home;

  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();

  const upstream = await startMockUpstream({ port: upstreamPort });

  const { loadConfig, saveConfig } = await import("../src/config.js");
  const { startProxyServer } = await import("../src/proxy-server.js");
  const { readLastProxyLogs } = await import("../src/logs.js");

  const config = loadConfig();
  config.server.host = host;
  config.server.port = proxyPort;
  config.agents.codex.providers = [
    {
      name: "cx-main",
      base_url: `http://${host}:${upstreamPort}`,
      api_key_env: "OPENAI_API_KEY",
      models: { default: null, sonnet: null, opus: null, haiku: null },
      failover: { enabled: false, order: null },
    },
  ];
  config.agents.codex.active = "cx-main";
  saveConfig(config);

  const proxy = await startProxyServer({ host, port: proxyPort });

  try {
    const response = await fetch(`http://${host}:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: "hi" }),
    });

    assert.equal(response.status, 200);
    await response.text();

    const logs = readLastProxyLogs(10);
    const done = [...logs].reverse().find((item) => item.phase === "done" && item.agent === "codex");
    assert.ok(done, "expected done log entry");
    assert.equal(done.tokens?.input, 120);
    assert.equal(done.tokens?.output, 40);
    assert.equal(done.tokens?.cache_read, 10);
    assert.equal(typeof done.tps, "number");
    assert.ok(done.tps > 0);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("goal: codex usage supports nested usage details fields", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-codex-usage-nested-"));
  process.env.HOME = home;

  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();

  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp_nested",
          result: {
            usage: {
              input_tokens: 88,
              output_tokens: 22,
              input_tokens_details: {
                cached_tokens: 11,
              },
            },
          },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.once("error", reject);
    server.listen(upstreamPort, host, () => resolve(server));
  });

  const { loadConfig, saveConfig } = await import("../src/config.js");
  const { startProxyServer } = await import("../src/proxy-server.js");
  const { readLastProxyLogs } = await import("../src/logs.js");

  const config = loadConfig();
  config.server.host = host;
  config.server.port = proxyPort;
  config.agents.codex.providers = [
    {
      name: "cx-nested",
      base_url: `http://${host}:${upstreamPort}`,
      api_key_env: "OPENAI_API_KEY",
      models: { default: null, sonnet: null, opus: null, haiku: null },
      failover: { enabled: false, order: null },
    },
  ];
  config.agents.codex.active = "cx-nested";
  saveConfig(config);

  const proxy = await startProxyServer({ host, port: proxyPort });
  try {
    const response = await fetch(`http://${host}:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const logs = readLastProxyLogs(10);
    const done = [...logs].reverse().find((item) => item.phase === "done" && item.agent === "codex");
    assert.ok(done, "expected done log entry");
    assert.equal(done.tokens?.input, 88);
    assert.equal(done.tokens?.output, 22);
    assert.equal(done.tokens?.cache_read, 11);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("goal: codex Responses SSE ttft uses first output_text delta", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-codex-ttft-"));
  process.env.HOME = home;

  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();

  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_ttft" } })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "你" })}\n\n`);
          res.write(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { usage: { input_tokens: 3, output_tokens: 1 } },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }, 80);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.once("error", reject);
    server.listen(upstreamPort, host, () => resolve(server));
  });

  const { loadConfig, saveConfig } = await import("../src/config.js");
  const { startProxyServer } = await import("../src/proxy-server.js");
  const { readLastProxyLogs } = await import("../src/logs.js");

  const config = loadConfig();
  config.server.host = host;
  config.server.port = proxyPort;
  config.agents.codex.providers = [
    {
      name: "cx-ttft",
      base_url: `http://${host}:${upstreamPort}`,
      api_key_env: "OPENAI_API_KEY",
      models: { default: null, sonnet: null, opus: null, haiku: null },
      failover: { enabled: false, order: null },
    },
  ];
  config.agents.codex.active = "cx-ttft";
  saveConfig(config);

  const proxy = await startProxyServer({ host, port: proxyPort });
  try {
    const response = await fetch(`http://${host}:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: "hi" }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const logs = readLastProxyLogs(10);
    const done = [...logs].reverse().find((item) => item.phase === "done" && item.agent === "codex");
    assert.ok(done, "expected done log entry");
    assert.ok(done.ttft >= 0.05, `expected content ttft, got ${done.ttft}`);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
