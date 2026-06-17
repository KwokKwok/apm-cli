import test from "node:test";
import assert from "node:assert/strict";

import { formatProxyLog } from "../src/logs.js";

test("goal: proxy log formatter keeps old ttft_ms entries readable", () => {
  const line = formatProxyLog({
    ts: "2026-06-17T00:00:00.000Z",
    phase: "done",
    agent: "codex",
    provider: "cx",
    model: "gpt",
    status: 200,
    tokens: { output: 10 },
    ttft_ms: 1234,
    tps: 5,
  });

  assert.match(line, /ttft=1\.23s/);
});
