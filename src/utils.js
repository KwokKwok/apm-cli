import fs from "node:fs";
import path from "node:path";

export function readJson(pathname, fallback = {}) {
  if (!fs.existsSync(pathname)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function readText(filePath, fallback = "") {
  if (!fs.existsSync(filePath)) return fallback;
  return fs.readFileSync(filePath, "utf8");
}

export function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

export function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function isEmptyObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  return Object.keys(obj).length === 0;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sectionRegex(name) {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\n?\\s*\\[${escaped}\\]\\s*[\\s\\S]*?(?=\\n\\s*\\[|$)`, "g");
}

export const APM_API_KEY = "apm-proxy";

export const AGENT_KIND = {
  CODEX: "openai-compatible",
  CLAUDE_CODE: "anthropic-compatible",
};

export const AGENT_NAMES = {
  [AGENT_KIND.CODEX]: "codex",
  [AGENT_KIND.CLAUDE_CODE]: "claude-code",
};

export const APM_HEADER = {
  CODEX: "openai-compatible",
  CLAUDE_CODE: "anthropic-compatible",
};

export function normalizeAgentToKind(agent) {
  if (!agent) return null;
  const v = String(agent).toLowerCase();
  if (v === "codex") return AGENT_KIND.CODEX;
  if (v === "claude" || v === "claude-code") return AGENT_KIND.CLAUDE_CODE;
  return null;
}
