import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");

function runCli({ home, cwd, args }) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("goal: claude local binding writes into current working directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apm-local-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-home-"));

  const outer = path.join(tmp, "outer");
  const project = path.join(outer, "project-a");
  const nested = path.join(project, "src", "nested");

  fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n", "utf8");

  runCli({
    home,
    cwd: project,
    args: [
      "cc",
      "add",
      "mini",
      "--base-url",
      "https://example-claude.test",
      "--api-key-env",
      "CC_KEY",
    ],
  });

  const out = runCli({
    home,
    cwd: project,
    args: ["cc", "use", "mini", "--local", "--json"],
  });

  const data = JSON.parse(out);
  const expected = path.join(project, ".claude", "settings.local.json");
  assert.ok(fs.existsSync(expected));
  assert.equal(fs.realpathSync(data.localPath), fs.realpathSync(expected));
});

test("goal: claude local binding requires confirmation when no marker exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "apm-project-no-marker-"));

  runCli({
    home,
    cwd: project,
    args: [
      "cc",
      "add",
      "mini",
      "--base-url",
      "https://example-claude.test",
      "--api-key-env",
      "CC_KEY",
    ],
  });

  assert.throws(
    () =>
      runCli({
        home,
        cwd: project,
        args: ["cc", "use", "mini", "--local"],
      }),
    /current directory has no project marker/,
  );
});

test("goal: codex local binding is rejected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "apm-project-"));

  runCli({
    home,
    cwd: project,
    args: [
      "codex",
      "add",
      "mini",
      "--base-url",
      "https://example-codex.test/v1",
      "--api-key-env",
      "CX_KEY",
    ],
  });

  assert.throws(
    () =>
      runCli({
        home,
        cwd: project,
        args: ["codex", "use", "mini", "--local"],
      }),
    /codex does not support project-level custom providers/,
  );
});

test("goal: unset local works even when binding registry is missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apm-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "apm-project-"));
  const claudeDir = path.join(project, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.local.json"),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:4891/p/demo",
          ANTHROPIC_API_KEY: "apm-proxy",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  runCli({
    home,
    cwd: project,
    args: ["cc", "unset", "--local"],
  });

  const localPath = path.join(claudeDir, "settings.local.json");
  if (!fs.existsSync(localPath)) {
    assert.equal(fs.existsSync(claudeDir), false);
    assert.ok(true);
    return;
  }
  const next = JSON.parse(fs.readFileSync(localPath, "utf8"));
  assert.equal(next?.env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(next?.env?.ANTHROPIC_API_KEY, undefined);
});
