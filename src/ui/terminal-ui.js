function isColorEnabled() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout?.isTTY);
}

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
};

class Tone {
  constructor(enabled) {
    this.enabled = enabled;
  }

  paint(text, code) {
    if (!this.enabled) return String(text);
    return `${code}${text}${COLOR.reset}`;
  }

  bold(text) { return this.paint(text, COLOR.bold); }
  dim(text) { return this.paint(text, COLOR.dim); }
  green(text) { return this.paint(text, COLOR.green); }
  red(text) { return this.paint(text, COLOR.red); }
  yellow(text) { return this.paint(text, COLOR.yellow); }
  blue(text) { return this.paint(text, COLOR.blue); }
  magenta(text) { return this.paint(text, COLOR.magenta); }
  cyan(text) { return this.paint(text, COLOR.cyan); }
  gray(text) { return this.paint(text, COLOR.gray); }
  bgBlue(text) { return this.paint(text, COLOR.bgBlue); }
  bgMagenta(text) { return this.paint(text, COLOR.bgMagenta); }
}

const tone = new Tone(isColorEnabled());

function formatCell(value) {
  return String(value ?? "-");
}

function statusBadge(flag) {
  if (flag === true) return tone.green("[on]");
  if (flag === false) return tone.gray("[off]");
  return "-";
}

function resultBadge(ok) {
  return ok ? tone.green("OK") : tone.red("FAIL");
}

function colorStatusCode(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return String(status ?? "-");
  if (code >= 200 && code < 300) return tone.green(String(code));
  if (code >= 400 && code < 500) return tone.yellow(String(code));
  if (code >= 500) return tone.red(String(code));
  return String(code);
}

function toLocalTimeLabel(ts) {
  if (!ts || ts === "-") return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const date = d.toLocaleDateString(undefined, {
    month: "2-digit",
    day: "2-digit",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${date} ${time}`;
}

function formatSeconds(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(1)}s`;
}

function readTtftSeconds(entry) {
  if (entry?.ttft != null) return entry.ttft;
  if (entry?.ttft_ms == null) return null;
  return Number(entry.ttft_ms) / 1000;
}

function formatTpsInteger(tps) {
  const n = Number(tps);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  if (n < 1) return "1";
  return String(Math.round(n));
}

function printTable(columns, rows) {
  const widths = columns.map((col) => col.length);
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx], formatCell(cell).length);
    });
  }

  const renderRow = (row) => row
    .map((cell, idx) => formatCell(cell).padEnd(widths[idx], " "))
    .join("  ");

  console.log(tone.bold(renderRow(columns)));
  console.log(tone.dim(widths.map((w) => "-".repeat(w)).join("  ")));
  for (const row of rows) {
    console.log(renderRow(row));
  }
}

function section(title) {
  const line = "-".repeat(Math.max(24, title.length + 8));
  console.log(tone.dim(line));
  console.log(tone.bold(`[ ${title} ]`));
  console.log(tone.dim(line));
}

function titleBar(title, color = "blue") {
  const text = ` ${title} `;
  if (!tone.enabled) {
    section(title);
    return;
  }
  const paint = color === "magenta" ? tone.bgMagenta.bind(tone) : tone.bgBlue.bind(tone);
  console.log(paint(tone.bold(text)));
}

function agentTitle(agent) {
  return agent === "codex" ? "CODEX" : "CLAUDE-CODE";
}

function renderCurrentLine(agent, local, globalProvider) {
  if (local?.isApmProxy && local.routeId) {
    console.log(`source: ${tone.cyan("local")}`);
    console.log(`route: ${local.routeId}`);
    console.log(`config: ${local.localPath || local.configPath || "-"}`);
  } else if (globalProvider) {
    console.log(`source: ${tone.blue("global")}`);
    console.log(`provider: ${globalProvider.name}`);
    console.log(`target: ${globalProvider.base_url}`);
  } else {
    console.log(`source: ${tone.gray("none")}`);
  }
}

function printKvGrid(pairs, keyWidth = 14) {
  const colGap = "  ";
  const half = Math.ceil(pairs.length / 2);
  const left = pairs.slice(0, half);
  const right = pairs.slice(half);
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i += 1) {
    const a = left[i];
    const b = right[i];
    const leftText = a ? `${String(a[0]).padEnd(keyWidth, " ")} ${a[1]}` : "".padEnd(keyWidth + 2, " ");
    const rightText = b ? `${String(b[0]).padEnd(keyWidth, " ")} ${b[1]}` : "";
    console.log(`${leftText}${colGap}${rightText}`.trimEnd());
  }
}

function resolutionSummary(local, globalProvider) {
  if (local?.isApmProxy && local.routeId) return `local(${local.routeId})`;
  if (globalProvider?.name) return `global(${globalProvider.name})`;
  return "none";
}

function card(title, lines = []) {
  const width = Math.max(
    title.length + 4,
    ...lines.map((line) => String(line).length + 4),
    24,
  );
  const top = `┌${"─".repeat(width - 2)}┐`;
  const bottom = `└${"─".repeat(width - 2)}┘`;
  const titleLine = `│ ${tone.bold(title).padEnd(width - 3, " ")}│`;
  console.log(tone.dim(top));
  console.log(titleLine);
  console.log(tone.dim(`├${"─".repeat(width - 2)}┤`));
  for (const line of lines) {
    const text = String(line);
    console.log(`│ ${text.padEnd(width - 3, " ")}│`);
  }
  console.log(tone.dim(bottom));
}

function indentAgent(label, text) {
  const width = 8;
  const prefix = label.padEnd(width, " ");
  return `${prefix}${text}`;
}

export class TerminalUi {
  static printOutput(options, data, textRenderer) {
    if (options?.json === true) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    textRenderer(data);
  }

  static printHelp() {
    console.log(`apm - Agent Provider Manager

Usage:
  apm <agent> add <name> --base-url <url> --api-key-env <ENV> [--model <id>] [--sonnet <id>] [--opus <id>] [--haiku <id>]
  apm <agent> update <name> [--base-url <url>] [--api-key-env <ENV>] [--model <id>] [--sonnet <id>] [--opus <id>] [--haiku <id>]
  apm <agent> list [--json]
  apm <agent> show <name> [--json]
  apm <agent> remove <name>
  apm <agent> use <name> [--global|--local] [--json]
  apm <agent> unset --local
  apm <agent> test <name|--all> [--model <id>] [--inference] [--json]
  apm <agent> failover on|off
  apm <agent> failover enable <provider>
  apm <agent> failover disable <provider>
  apm <agent> failover move <provider> --to <index>
  apm <agent> enable
  apm <agent> disable
  apm codex oauth

  apm list [--json]
  apm rename <old-name> <new-name> [-a <codex|claude-code|cc>]
  apm enable <codex|claude-code|cc>   # backward compatible
  apm disable <codex|claude-code|cc>  # backward compatible
  apm import cc-switch [--db <path>] [--agent <codex|claude-code|all>] [--json]
  apm start [--host <host>] [--port <port>]
  apm stop
  apm status [--json]
  apm logs [--lines <N>] [--follow|-f]
  apm --help

Agents:
  codex
  claude-code
  cc (alias of claude-code)
`);
  }

  static agentTitle(agent) {
    return agentTitle(agent);
  }

  static section(title) {
    section(title);
  }

  static renderAgentList(agent, providers, active) {
    section(`${agentTitle(agent)} Providers`);
    if (providers.length === 0) {
      console.log(tone.gray("(no providers)"));
      return;
    }

    const rows = providers.map((provider) => [
      provider.name === active ? tone.green("*") : " ",
      provider.name,
      provider.base_url,
      provider?.models?.default || "-",
      `${provider?.failover?.enabled ? "on" : "off"}#${provider?.failover?.order ?? "-"}`,
    ]);
    printTable(["A", "Provider", "Base URL", "Model", "Failover"], rows);
  }

  static renderProviderDetail(agent, provider) {
    section(`${agentTitle(agent)} / ${provider.name}`);
    printTable(["Field", "Value"], [
      ["base_url", provider.base_url],
      ["api_key_env", provider.api_key_env],
      ["model", provider.models?.default || "-"],
      ["sonnet", provider.models?.sonnet || "-"],
      ["opus", provider.models?.opus || "-"],
      ["haiku", provider.models?.haiku || "-"],
      ["failover", `${provider.failover?.enabled ? "on" : "off"}#${provider.failover?.order ?? "-"}`],
    ]);
  }

  static renderActiveProvider(agent, scope, provider, localPath = null) {
    section(`${agentTitle(agent)} Active Provider`);
    console.log(`scope: ${scope === "local" ? tone.cyan(scope) : tone.blue(scope)}`);
    console.log(`provider: ${tone.bold(provider)}`);
    if (localPath) {
      console.log(`local_config: ${localPath}`);
    }
  }

  static renderStatus(data) {
    const { proxy, takeover, failover, current } = data;
    titleBar("Overview", "blue");
    const proxyLabel = proxy.running ? tone.green("running") : tone.gray("stopped");
    const proxyPid = proxy.running && proxy.pid ? tone.dim(` (pid: ${proxy.pid})`) : "";
    console.log(`proxy      ${proxyLabel}${proxyPid}  ${proxy.running ? `${proxy.host}:${String(proxy.port)}` : "-"}`);
    console.log(indentAgent("codex", tone.cyan(resolutionSummary(current.codex.local, current.codex.global))));
    console.log(indentAgent("", `takeover ${statusBadge(takeover.codex)}`));
    console.log(indentAgent("", `failover ${statusBadge(failover.codex)}`));
    console.log(indentAgent("claude", tone.cyan(resolutionSummary(current["claude-code"].local, current["claude-code"].global))));
    console.log(indentAgent("", `takeover ${statusBadge(takeover["claude-code"])}`));
    console.log(indentAgent("", `failover ${statusBadge(failover["claude-code"])}`));
    console.log("");
    titleBar("Codex Route", "blue");
    renderCurrentLine("codex", current.codex.local, current.codex.global);
    console.log("");
    titleBar("Claude Code Route", "blue");
    renderCurrentLine(
      "claude-code",
      current["claude-code"].local,
      current["claude-code"].global,
    );

    const warnings = [];
    if ((takeover.codex || takeover["claude-code"]) && !proxy.running) {
      warnings.push("takeover is enabled but proxy is not running");
    }
    if (!current.codex.local?.isApmProxy && !current.codex.global) {
      warnings.push("Codex has no active provider");
    }
    if (!current["claude-code"].local?.isApmProxy && !current["claude-code"].global) {
      warnings.push("Claude Code has no active provider");
    }

    if (warnings.length > 0) {
      console.log("");
      titleBar("WARNINGS", "magenta");
      for (const msg of warnings) {
        console.log(`${tone.yellow("!")} ${msg}`);
      }
    }
  }

  static renderImportResult(data) {
    section("Import Result");
    console.log(`source: ${tone.magenta("cc-switch")}`);
    console.log(`target_agent: ${data.targetAgent}`);
    console.log(`db: ${data.dbPath}`);
    console.log(`scanned: ${data.totalScanned}`);
    console.log(`applied: ${data.applied}`);
    console.log(`created: ${tone.green(String(data.imported))}`);
    console.log(`updated: ${tone.cyan(String(data.updated))}`);
  }

  static renderTestResultLine(item) {
    const badge = resultBadge(item.ok);
    console.log(`${badge} ${item.provider}  ${item.message}`);
  }

  static renderSingleTestResult(ok, provider, message) {
    const badge = resultBadge(ok);
    console.log(`${badge} ${provider}  ${message}`);
  }

  static renderProxyLog(entry, fallbackLine) {
    if (!entry || typeof entry !== "object") {
      console.log(fallbackLine);
      return;
    }
    const ts = toLocalTimeLabel(entry.ts || "-");
    const phase = entry.phase || "done";
    const agent = entry.agent || "-";
    const provider = entry.provider || "-";
    const model = entry.model ? String(entry.model) : "-";
    const status = colorStatusCode(entry.status ?? "-");
    const ttft = formatSeconds(readTtftSeconds(entry));
    const tps = formatTpsInteger(entry.tps);
    const phaseText = phase === "done" ? tone.green(phase) : tone.yellow(phase);
    if (phase === "start") {
      console.log(`${tone.dim(ts)} ${phaseText} ${tone.bold(agent)} ${provider} ${tone.cyan(model)}`);
      return;
    }
    const metrics = [`status=${status}`];
    if (ttft) metrics.push(`ttft=${ttft}`);
    if (tps) metrics.push(`tps=${tps}`);
    console.log(`${tone.dim(ts)} ${phaseText} ${tone.bold(agent)} ${provider} ${tone.cyan(model)} ${metrics.join(" ")}`);
  }
}
