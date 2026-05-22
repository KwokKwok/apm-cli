import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");

function hasSqlite() {
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function runCli(home, args) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function readConfig(home) {
  const configPath = path.join(home, ".apm", "config.yaml");
  const raw = fs.readFileSync(configPath, "utf8");
  return parse(raw);
}

test("goal: cc-switch import lands providers into correct agent pools", { skip: !hasSqlite() }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-import-"));
  const dbPath = path.join(home, "cc-switch.db");

  const setupSql = `
CREATE TABLE providers (
  id TEXT,
  name TEXT,
  app_type TEXT,
  settings_config TEXT,
  sort_index INTEGER,
  in_failover_queue INTEGER,
  created_at TEXT
);
INSERT INTO providers VALUES (
  '1',
  'cx-imported',
  'codex',
  '{"config":"base_url = \\"https://codex.example/v1\\"\\nmodel = \\"gpt-5\\"","auth":{"OPENAI_API_KEY":"x"}}',
  1,
  1,
  '2026-01-01T00:00:00Z'
);
INSERT INTO providers VALUES (
  '2',
  'cc-imported',
  'claude',
  '{"env":{"ANTHROPIC_BASE_URL":"https://claude.example","ANTHROPIC_MODEL":"claude-sonnet"}}',
  1,
  0,
  '2026-01-01T00:00:01Z'
);
`;
  execFileSync("sqlite3", [dbPath, setupSql], { encoding: "utf8" });

  const output = runCli(home, ["import", "cc-switch", "--db", dbPath, "--json"]);
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);

  const config = readConfig(home);
  assert.equal(config.agents.codex.providers.length, 1);
  assert.equal(config.agents["claude-code"].providers.length, 1);
  assert.equal(config.agents.codex.providers[0].name, "cx-imported");
  assert.equal(config.agents["claude-code"].providers[0].name, "cc-imported");
  assert.equal(config.agents.codex.providers[0].failover.enabled, true);
  assert.equal(config.agents["claude-code"].providers[0].failover.enabled, false);
});
