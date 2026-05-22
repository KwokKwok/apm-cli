import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");

function runCli({ home, cwd = REPO_ROOT, args }) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function readConfig(home) {
  const configPath = path.join(home, ".apm", "config.yaml");
  return parse(fs.readFileSync(configPath, "utf8"));
}

test("goal: rename requires -a when name is ambiguous across agents", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-rename-amb-"));
  runCli({ home, args: ["codex", "add", "mini", "--base-url", "https://example-codex.test/v1", "--api-key-env", "CX_KEY"] });
  runCli({ home, args: ["cc", "add", "mini", "--base-url", "https://example-claude.test", "--api-key-env", "CC_KEY"] });

  assert.throws(
    () => runCli({ home, args: ["rename", "mini", "MiniMax Coding"] }),
    /ambiguous|use -a to specify agent/i,
  );
});

test("goal: rename supports fuzzy match with explicit agent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-rename-fuzzy-"));
  runCli({ home, args: ["codex", "add", "mini-cx", "--base-url", "https://example-codex.test/v1", "--api-key-env", "CX_KEY"] });
  runCli({ home, args: ["codex", "use", "mini-cx", "--global"] });

  runCli({ home, args: ["rename", "mini", "MiniMax Coding", "-a", "codex"] });

  const config = readConfig(home);
  assert.equal(config.agents.codex.active, "MiniMax Coding");
  assert.equal(config.agents.codex.providers.some((p) => p.name === "MiniMax Coding"), true);
  assert.equal(config.agents.codex.providers.some((p) => p.name === "mini-cx"), false);
});

test("goal: rename updates claude local route references", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-rename-local-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "apm-rename-project-"));
  fs.writeFileSync(path.join(project, "package.json"), "{}\n", "utf8");

  runCli({ home, cwd: project, args: ["cc", "add", "mini", "--base-url", "https://example-claude.test", "--api-key-env", "CC_KEY"] });
  runCli({ home, cwd: project, args: ["cc", "use", "mini", "--local"] });

  const localPath = path.join(project, ".claude", "settings.local.json");
  const before = JSON.parse(fs.readFileSync(localPath, "utf8"));
  assert.match(before.env.ANTHROPIC_BASE_URL, /\/p\/cc-mini(?:\/|$)/);

  runCli({ home, cwd: project, args: ["rename", "mini", "MiniMax Coding", "-a", "cc"] });

  const after = JSON.parse(fs.readFileSync(localPath, "utf8"));
  assert.match(after.env.ANTHROPIC_BASE_URL, /\/p\/cc-minimax-coding(?:\/|$)/);

  const config = readConfig(home);
  assert.equal(config.agents["claude-code"].providers.some((p) => p.name === "MiniMax Coding"), true);
});
