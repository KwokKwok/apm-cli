import fs from "node:fs";
import path from "node:path";
import { getApmHome, ensureApmLayout } from "./config.js";

const LOG_FILE = "proxy.log.ndjson";

export function getProxyLogPath() {
  return path.join(getApmHome(), "runtime", LOG_FILE);
}

export function appendProxyLog(entry) {
  ensureApmLayout();
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(getProxyLogPath(), line, "utf8");
}

function parseLines(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readLastProxyLogs(lines = 20) {
  ensureApmLayout();
  const filePath = getProxyLogPath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseLines(raw);
  return parsed.slice(Math.max(0, parsed.length - lines));
}

function fmt(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return "-";
  if (typeof value === "number") return value.toFixed(digits);
  return String(value);
}

export function formatProxyLog(entry) {
  const ts = entry.ts || "-";
  const phase = entry.phase || "done";
  const provider = entry.provider || "-";
  const model = entry.model || "-";
  const upstreamModel = entry.upstream_model || "-";
  const inTok = entry.tokens?.input ?? null;
  const outTok = entry.tokens?.output ?? null;
  const cacheRead = entry.tokens?.cache_read ?? null;
  const cacheCreate = entry.tokens?.cache_create ?? null;
  const ttft = entry.ttft_ms ?? null;
  const tps = entry.tps ?? null;
  const status = entry.status ?? "-";
  const agent = entry.agent || "-";
  const candidates = Array.isArray(entry.candidates)
    ? entry.candidates.join(">")
    : "-";
  return `${ts} phase=${phase} agent=${agent} provider=${provider} model=${model} upstream_model=${upstreamModel} status=${status} in=${fmt(inTok, 0)} out=${fmt(outTok, 0)} cache_read=${fmt(cacheRead, 0)} cache_create=${fmt(cacheCreate, 0)} ttft_ms=${fmt(ttft, 0)} tps=${fmt(tps)} candidates=${candidates}`;
}
