import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");

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

test("goal: codex and claude-code maintain independent global providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-goal-"));

  runCli(home, ["codex", "add", "cx-main", "--base-url", "https://example-codex.test/v1", "--api-key-env", "CX_KEY"]);
  runCli(home, ["cc", "add", "cc-main", "--base-url", "https://example-claude.test", "--api-key-env", "CC_KEY"]);

  runCli(home, ["codex", "use", "cx-main", "--global"]);
  runCli(home, ["claude-code", "use", "cc-main", "--global"]);

  const config = readConfig(home);
  assert.equal(config.version, 2);
  assert.equal(config.agents.codex.active, "cx-main");
  assert.equal(config.agents["claude-code"].active, "cc-main");

  const statusRaw = runCli(home, ["status", "--json"]);
  const status = JSON.parse(statusRaw);
  assert.equal(status.current.codex.global.name, "cx-main");
  assert.equal(status.current["claude-code"].global.name, "cc-main");
});

test("goal: failover on/off is agent-scoped", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-failover-"));

  runCli(home, ["codex", "add", "cx-main", "--base-url", "https://example-codex.test/v1", "--api-key-env", "CX_KEY"]);
  runCli(home, ["cc", "add", "cc-main", "--base-url", "https://example-claude.test", "--api-key-env", "CC_KEY"]);

  runCli(home, ["codex", "failover", "on"]);

  let config = readConfig(home);
  assert.equal(config.agents.codex.failover.enabled, true);
  assert.equal(config.agents["claude-code"].failover.enabled, false);

  runCli(home, ["claude-code", "failover", "on"]);
  config = readConfig(home);
  assert.equal(config.agents.codex.failover.enabled, true);
  assert.equal(config.agents["claude-code"].failover.enabled, true);

  runCli(home, ["codex", "failover", "off"]);
  config = readConfig(home);
  assert.equal(config.agents.codex.failover.enabled, false);
  assert.equal(config.agents["claude-code"].failover.enabled, true);
});
