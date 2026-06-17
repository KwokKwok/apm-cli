import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");

function runCli(home, args) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("goal: repeated codex takeover keeps the original config backup", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-codex-takeover-"));
  process.env.HOME = home;
  const codexDir = path.join(home, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configPath = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    configPath,
    'model_provider = "openai"\nsandbox_mode = "workspace-write"\n',
    "utf8",
  );

  const { enableCodexTakeover, disableCodexTakeover } = await import("../src/takeover.js");
  enableCodexTakeover("http://127.0.0.1:4891");
  enableCodexTakeover("http://127.0.0.1:4891");
  disableCodexTakeover();

  assert.equal(
    fs.readFileSync(configPath, "utf8"),
    'model_provider = "openai"\nsandbox_mode = "workspace-write"\n',
  );
});

test("goal: codex oauth only removes apm provider and preserves user custom providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-codex-oauth-"));
  const codexDir = path.join(home, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configPath = path.join(codexDir, "config.toml");
  const authPath = path.join(codexDir, "auth.json");
  fs.writeFileSync(
    configPath,
    `model_provider = "apm"
preferred_auth_method = "apikey"
sandbox_mode = "workspace-write"

[model_providers.custom]
name = "custom"
base_url = "https://example.test/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.apm]
name = "apm"
base_url = "http://127.0.0.1:4891/v1"
wire_api = "responses"
requires_openai_auth = true
`,
    "utf8",
  );
  fs.writeFileSync(
    authPath,
    JSON.stringify({ OPENAI_API_KEY: "third-party-key", tokens: { id: "oauth-token" } }, null, 2) + "\n",
    "utf8",
  );

  runCli(home, ["codex", "oauth"]);
  const after = fs.readFileSync(configPath, "utf8");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.doesNotMatch(after, /^\s*model_provider\s*=/m);
  assert.doesNotMatch(after, /^\s*preferred_auth_method\s*=/m);
  assert.doesNotMatch(after, /\[model_providers\.apm\]/);
  assert.match(after, /\[model_providers\.custom\]/);
  assert.match(after, /base_url = "https:\/\/example\.test\/v1"/);
  assert.match(after, /sandbox_mode = "workspace-write"/);
  assert.equal(auth.OPENAI_API_KEY, undefined);
  assert.deepEqual(auth.tokens, { id: "oauth-token" });
});

test("goal: repeated claude takeover keeps the original settings backup", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-claude-takeover-"));
  process.env.HOME = home;
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, null, 2) + "\n",
    "utf8",
  );

  const { enableClaudeTakeover, disableClaudeTakeover } = await import("../src/takeover.js");
  enableClaudeTakeover("http://127.0.0.1:4891");
  enableClaudeTakeover("http://127.0.0.1:4891");
  disableClaudeTakeover();

  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, undefined);
});
