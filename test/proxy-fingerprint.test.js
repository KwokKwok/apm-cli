import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("goal: proxy exposes stable APM fingerprint", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-health-"));
  process.env.HOME = home;

  const { startProxyServer } = await import("../src/proxy-server.js");
  const { checkIfApmService, APM_SERVICE_HEADER, APM_SERVICE_NAME } = await import("../src/runtime.js");

  const host = "127.0.0.1";
  const port = 53991;
  const server = await startProxyServer({ host, port });

  try {
    const response = await fetch(`http://${host}:${port}/__apm/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get(APM_SERVICE_HEADER), APM_SERVICE_NAME);
    assert.equal(body.ok, true);
    assert.equal(body.service, "apm-cli");

    const detected = await checkIfApmService(host, port);
    assert.equal(detected, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
