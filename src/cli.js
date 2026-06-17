import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import {
  AGENTS,
  findProvider,
  getActiveProvider,
  getAgentConfig,
  loadConfig,
  normalizeAgent,
  providerRouteId,
  saveConfig,
} from "./config.js";
import {
  cleanupLocalBinding,
  hasProjectRootMarker,
  readLocalBinding,
  renameLocalRouteReferences,
  writeLocalBinding,
} from "./bindings.js";
import { importFromCcSwitch } from "./import-cc-switch.js";
import { testProvider } from "./provider-test.js";
import { startProxyServer } from "./proxy-server.js";
import {
  checkPortAndService,
  clearProxyRuntime,
  isPidAlive,
  readProxyRuntime,
  writeProxyRuntime,
} from "./runtime.js";
import {
  disableClaudeTakeover,
  disableCodexTakeover,
  enableClaudeTakeover,
  enableCodexTakeover,
  getTakeoverState,
  resetCodexToOAuth,
} from "./takeover.js";
import { formatProxyLog, getProxyLogPath, readLastProxyLogs } from "./logs.js";
import { TerminalUi } from "./ui/terminal-ui.js";

function parseOptions(args) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    let key = null;
    if (token.startsWith("--")) {
      key = token.slice(2);
    } else if (token === "-l") {
      key = "local";
    } else if (token === "-g") {
      key = "global";
    } else if (token === "-f") {
      key = "follow";
    } else if (token === "-a") {
      key = "agent";
    } else if (token === "-h") {
      key = "help";
    }

    if (!key) continue;

    const value = args[i + 1];
    if (!value || value.startsWith("-")) {
      options[key] = true;
    } else {
      options[key] = value;
      i += 1;
    }
  }
  return { options, positionals };
}

function asJsonEnabled(options) {
  return options.json === true;
}

function resolveProviderByName(config, agent, rawName) {
  const needle = String(rawName || "").trim();
  if (!needle) throw new Error("missing provider name");

  const providers = config.agents[agent].providers;
  const exact = providers.filter((p) => p.name === needle);
  if (exact.length === 1) return exact[0];

  const lowerNeedle = needle.toLowerCase();
  const exactCi = providers.filter((p) => p.name.toLowerCase() === lowerNeedle);
  if (exactCi.length === 1) return exactCi[0];
  if (exactCi.length > 1) {
    const choices = exactCi.map((p) => p.name).join(", ");
    throw new Error(`provider name is ambiguous: ${needle}. matches: ${choices}`);
  }

  const partial = providers.filter((p) => p.name.toLowerCase().includes(lowerNeedle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const choices = partial.map((p) => p.name).join(", ");
    throw new Error(`provider name is ambiguous: ${needle}. matches: ${choices}`);
  }

  throw new Error(`provider not found: ${needle}`);
}

function collectRenameMatches(config, agents, rawName) {
  const needle = String(rawName || "").trim();
  const lowerNeedle = needle.toLowerCase();
  const bag = [];
  for (const agent of agents) {
    for (const provider of config.agents[agent].providers) {
      bag.push({ agent, provider });
    }
  }
  const exact = bag.filter((item) => item.provider.name === needle);
  if (exact.length > 0) return exact;
  const exactCi = bag.filter((item) => item.provider.name.toLowerCase() === lowerNeedle);
  if (exactCi.length > 0) return exactCi;
  return bag.filter((item) => item.provider.name.toLowerCase().includes(lowerNeedle));
}

function ensureProviderFailover(provider) {
  provider.failover = provider.failover || { enabled: false, order: null };
  if (typeof provider.failover.enabled !== "boolean") {
    provider.failover.enabled = false;
  }
  if (typeof provider.failover.order !== "number") {
    provider.failover.order = null;
  }
}

function sortedFailoverQueue(config, agent) {
  return config.agents[agent].providers
    .filter((provider) => provider.failover?.enabled)
    .sort((a, b) => {
      const ao = a.failover?.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.failover?.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });
}

function normalizeQueueOrder(config, agent) {
  const queue = sortedFailoverQueue(config, agent);
  queue.forEach((provider, index) => {
    provider.failover.order = index + 1;
  });
}

function normalizedServer(config, options = {}) {
  return {
    host: String(options.host || config.server.host || "127.0.0.1"),
    port: Number(options.port || config.server.port || 4891),
  };
}

function cmdAgentAdd(agent, args) {
  const { options, positionals } = parseOptions(args);
  const [name] = positionals;
  if (!name) throw new Error("missing provider name");

  const baseUrl = options["base-url"];
  const apiKeyEnv = options["api-key-env"];
  if (!baseUrl || !apiKeyEnv) {
    throw new Error("add requires --base-url <url> --api-key-env <ENV>");
  }

  const config = loadConfig();
  if (findProvider(config, agent, name)) {
    throw new Error(`provider already exists: ${name}`);
  }

  const pool = config.agents[agent];
  pool.providers.push({
    name,
    base_url: String(baseUrl),
    api_key_env: String(apiKeyEnv),
    models: {
      default: options.model || null,
      sonnet: options.sonnet || null,
      opus: options.opus || null,
      haiku: options.haiku || null,
    },
    failover: {
      enabled: false,
      order: null,
    },
  });
  if (!pool.active) {
    pool.active = name;
  }
  saveConfig(config);

  TerminalUi.printOutput(options, { ok: true, agent, provider: name }, () => {
    console.log(`[${TerminalUi.agentTitle(agent)}] added provider: ${name}`);
  });
}

function cmdAgentUpdate(agent, args) {
  const { options, positionals } = parseOptions(args);
  const [name] = positionals;
  if (!name) throw new Error("missing provider name");

  const config = loadConfig();
  const provider = resolveProviderByName(config, agent, name);

  if (options["base-url"] !== undefined) {
    provider.base_url = String(options["base-url"]);
  }
  if (options["api-key-env"] !== undefined) {
    provider.api_key_env = String(options["api-key-env"]);
  }
  if (options.model !== undefined) {
    provider.models.default = options.model || null;
  }
  if (options.sonnet !== undefined) {
    provider.models.sonnet = options.sonnet || null;
  }
  if (options.opus !== undefined) {
    provider.models.opus = options.opus || null;
  }
  if (options.haiku !== undefined) {
    provider.models.haiku = options.haiku || null;
  }

  saveConfig(config);

  TerminalUi.printOutput(options, { ok: true, agent, provider: name }, () => {
    console.log(`[${TerminalUi.agentTitle(agent)}] updated provider: ${name}`);
  });
}

function cmdAgentList(agent, args) {
  const { options } = parseOptions(args);
  const config = loadConfig();
  const pool = getAgentConfig(config, agent);
  const data = {
    agent,
    active: pool.active,
    providers: pool.providers,
  };
  TerminalUi.printOutput(options, data, () => TerminalUi.renderAgentList(agent, pool.providers, pool.active));
}

function cmdRootList(args) {
  const { options } = parseOptions(args);
  const config = loadConfig();
  const data = {
    codex: {
      active: config.agents.codex.active,
      providers: config.agents.codex.providers,
    },
    "claude-code": {
      active: config.agents["claude-code"].active,
      providers: config.agents["claude-code"].providers,
    },
  };
  TerminalUi.printOutput(options, data, () => {
    TerminalUi.renderAgentList("codex", data.codex.providers, data.codex.active);
    console.log("");
    TerminalUi.renderAgentList("claude-code", data["claude-code"].providers, data["claude-code"].active);
  });
}

function cmdAgentShow(agent, args) {
  const { options, positionals } = parseOptions(args);
  const [name] = positionals;
  if (!name) throw new Error("missing provider name");

  const config = loadConfig();
  const provider = resolveProviderByName(config, agent, name);
  TerminalUi.printOutput(options, { agent, provider }, (data) => {
    TerminalUi.renderProviderDetail(data.agent, data.provider);
  });
}

function cmdAgentRemove(agent, args) {
  const { positionals } = parseOptions(args);
  const [name] = positionals;
  if (!name) throw new Error("missing provider name");

  const config = loadConfig();
  const provider = resolveProviderByName(config, agent, name);
  const pool = config.agents[agent];
  pool.providers = pool.providers.filter((p) => p !== provider);

  if (pool.active === provider.name) {
    pool.active = pool.providers[0]?.name || null;
  }

  normalizeQueueOrder(config, agent);
  saveConfig(config);
  console.log(`[${TerminalUi.agentTitle(agent)}] removed provider: ${provider.name}`);
}

function cmdRename(args) {
  const { options, positionals } = parseOptions(args);
  const [oldName, newName] = positionals;
  if (!oldName || !newName) {
    throw new Error("rename requires: apm rename <old-name> <new-name> [-a <codex|claude-code|cc>]");
  }
  if (String(oldName).trim() === String(newName).trim()) {
    throw new Error("rename old and new names are identical");
  }

  const config = loadConfig();
  const forcedAgent = options.agent ? normalizeAgent(options.agent) : null;
  if (options.agent && !forcedAgent) {
    throw new Error("rename -a must be codex, claude-code or cc");
  }
  const targetAgents = forcedAgent ? [forcedAgent] : AGENTS;
  const matches = collectRenameMatches(config, targetAgents, oldName);
  if (matches.length === 0) {
    throw new Error(`provider not found: ${oldName}`);
  }
  if (matches.length > 1) {
    const tips = matches.map((item) => `${item.agent}:${item.provider.name}`).join(", ");
    throw new Error(`provider name is ambiguous: ${oldName}. matches: ${tips}. use -a to specify agent`);
  }

  const { agent, provider } = matches[0];
  const pool = config.agents[agent];
  const nextName = String(newName).trim();
  const lowerNext = nextName.toLowerCase();
  const duplicate = pool.providers.some(
    (item) => item !== provider && item.name.toLowerCase() === lowerNext,
  );
  if (duplicate) {
    throw new Error(`provider already exists: ${nextName}`);
  }

  const prevName = provider.name;
  const oldRouteId = providerRouteId(agent, prevName);
  provider.name = nextName;
  if (pool.active === prevName) {
    pool.active = nextName;
  }
  saveConfig(config);

  const newRouteId = providerRouteId(agent, nextName);
  const localPatched = renameLocalRouteReferences(agent, oldRouteId, newRouteId);
  console.log(`[${TerminalUi.agentTitle(agent)}] renamed: ${prevName} -> ${nextName} (local updated: ${localPatched.updated})`);
}

async function cmdAgentTest(agent, args) {
  const { options, positionals } = parseOptions(args);
  const [first] = positionals;
  const testAll = first === "--all" || options.all === true;
  const model = typeof options.model === "string" ? options.model : null;
  const inference = options.inference === true;

  const config = loadConfig();
  const providers = config.agents[agent].providers;

  if (testAll) {
    if (providers.length === 0) throw new Error("no providers to test");
    const results = [];
    let passed = 0;
    for (const provider of providers) {
      const result = await testProvider(agent, provider, 10_000, model, inference);
      results.push({ provider: provider.name, ...result });
      if (result.ok) passed += 1;
    }

  if (asJsonEnabled(options)) {
      console.log(JSON.stringify({ agent, passed, total: providers.length, results }, null, 2));
    } else {
      TerminalUi.section(`${TerminalUi.agentTitle(agent)} Test Results`);
      for (const item of results) {
        TerminalUi.renderTestResultLine(item);
      }
      console.log(`summary: ${passed}/${providers.length} passed`);
    }

    if (passed !== providers.length) {
      throw new Error(`test failed: ${providers.length - passed}/${providers.length} providers failed`);
    }
    return;
  }

  const name = first;
  if (!name) throw new Error("missing provider name or --all");
  const provider = resolveProviderByName(config, agent, name);
  const result = await testProvider(agent, provider, 10_000, model, inference);

  if (asJsonEnabled(options)) {
    console.log(JSON.stringify({ agent, provider: provider.name, ...result }, null, 2));
  } else {
    TerminalUi.renderSingleTestResult(result.ok, provider.name, result.message);
  }

  if (!result.ok) throw new Error(`provider test failed: ${result.message}`);
}

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function ensureLocalRootConfirmed(cwd) {
  if (hasProjectRootMarker(cwd)) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "current directory has no project marker (.git/package.json/.claude/.codex); run in interactive terminal and type Y to confirm",
    );
  }

  const answer = await askLine(
    `current directory has no project marker: ${cwd}\nconfirm this is project root? type Y to continue: `,
  );
  if (String(answer).trim() !== "Y") {
    throw new Error("aborted by user");
  }
}

async function cmdAgentUse(agent, args) {
  const { options, positionals } = parseOptions(args);
  const [name] = positionals;
  if (!name) throw new Error("missing provider name");

  const config = loadConfig();
  const provider = resolveProviderByName(config, agent, name);

  const isLocal = options.local === true;
  const isGlobal = options.global === true;
  if (isLocal && isGlobal) throw new Error("use either --local or --global, not both");

  const server = normalizedServer(config);
  const proxyOrigin = `http://${server.host}:${String(server.port)}`;

  if (isLocal) {
    if (agent === "claude-code") {
      await ensureLocalRootConfirmed(process.cwd());
    }

    const { localPath } = writeLocalBinding({
      cwd: process.cwd(),
      provider: provider.name,
      agent,
      proxyOrigin,
    });
  TerminalUi.printOutput(options, { scope: "local", agent, provider: provider.name, localPath }, (data) => {
      TerminalUi.renderActiveProvider(agent, "local", data.provider, data.localPath);
    });
    return;
  }

  config.agents[agent].active = provider.name;
  saveConfig(config);
  TerminalUi.printOutput(options, { scope: "global", agent, provider: provider.name }, (data) => {
    TerminalUi.renderActiveProvider(agent, "global", data.provider);
  });
}

function cmdAgentFailover(agent, args) {
  const { options, positionals } = parseOptions(args);
  const [sub, name] = positionals;
  if (!sub) throw new Error("failover requires subcommand: on|off|enable|disable|move");

  const config = loadConfig();

  if (sub === "on" || sub === "off") {
    config.agents[agent].failover = config.agents[agent].failover || { enabled: false };
    config.agents[agent].failover.enabled = sub === "on";
    saveConfig(config);
    TerminalUi.printOutput(
      options,
      { ok: true, scope: "agent", agent, failover: config.agents[agent].failover.enabled },
      (data) => {
        console.log(`[${TerminalUi.agentTitle(data.agent)}] failover ${data.failover ? "on" : "off"}`);
      },
    );
    return;
  }

  config.agents[agent].failover = config.agents[agent].failover || { enabled: false };
  if (!config.agents[agent].failover.enabled) {
    throw new Error(
      `[${TerminalUi.agentTitle(agent)}] failover is off. run: apm ${agent} failover on`,
    );
  }

  if (!name) throw new Error(`failover ${sub} requires provider`);
  const provider = resolveProviderByName(config, agent, name);
  ensureProviderFailover(provider);

  if (sub === "enable") {
    provider.failover.enabled = true;
    if (provider.failover.order == null) {
      const queue = sortedFailoverQueue(config, agent);
      const maxOrder = queue.reduce((max, item) => Math.max(max, item.failover?.order ?? 0), 0);
      provider.failover.order = maxOrder + 1;
    }
    normalizeQueueOrder(config, agent);
    saveConfig(config);
    console.log(`[${TerminalUi.agentTitle(agent)}] failover enabled: ${provider.name} #${provider.failover.order}`);
    return;
  }

  if (sub === "disable") {
    provider.failover.enabled = false;
    provider.failover.order = null;
    normalizeQueueOrder(config, agent);
    saveConfig(config);
    console.log(`[${TerminalUi.agentTitle(agent)}] failover disabled: ${provider.name}`);
    return;
  }

  if (sub === "move") {
    const to = Number(options.to);
    if (!Number.isInteger(to) || to <= 0) {
      throw new Error("failover move requires --to <index>, index starts from 1");
    }
    if (!provider.failover.enabled) {
      throw new Error(`provider ${provider.name} is not enabled in failover queue`);
    }

    const queue = sortedFailoverQueue(config, agent).filter((item) => item.name !== provider.name);
    const target = Math.min(Math.max(to, 1), queue.length + 1);
    queue.splice(target - 1, 0, provider);
    queue.forEach((item, index) => {
      item.failover.enabled = true;
      item.failover.order = index + 1;
    });
    saveConfig(config);
    console.log(`[${TerminalUi.agentTitle(agent)}] failover moved: ${provider.name} -> #${target}`);
    return;
  }

  throw new Error(`unknown failover subcommand: ${sub}`);
}

async function syncProxyLifecycleWithTakeover() {
  const takeover = getTakeoverState();
  const shouldRun = Boolean(takeover.codex || takeover.claude);
  const runtime = readProxyRuntime();
  const running = Boolean(runtime?.pid && isPidAlive(runtime.pid));

  if (shouldRun && !running) {
    await cmdStart([]);
    return;
  }
  if (!shouldRun && running) {
    cmdStop();
  }
}

async function cmdAgentTakeover(agent, args, runtimeOptions = {}) {
  const { positionals } = parseOptions(args);
  const [action] = positionals;
  if (!action || !["enable", "disable"].includes(action)) {
    throw new Error("takeover requires enable|disable");
  }
  const quiet = runtimeOptions.quiet === true;
  const enable = action === "enable";

  const config = loadConfig();
  const server = normalizedServer(config);
  const proxyOrigin = `http://${server.host}:${String(server.port)}`;

  if (agent === "codex") {
    if (enable) {
      const changed = enableCodexTakeover(proxyOrigin);
      if (!quiet) console.log(`codex takeover enabled: ${changed.authPath}, ${changed.configPath}`);
    } else {
      const changed = disableCodexTakeover();
      if (!quiet) console.log(`codex takeover disabled: ${changed.authPath}, ${changed.configPath}`);
    }
    await syncProxyLifecycleWithTakeover();
    return;
  }

  if (enable) {
    const changed = enableClaudeTakeover(proxyOrigin);
    if (!quiet) console.log(`claude-code takeover enabled: ${changed.settingsPath}`);
  } else {
    const changed = disableClaudeTakeover();
    if (!quiet) console.log(`claude-code takeover disabled: ${changed.settingsPath}`);
  }
  await syncProxyLifecycleWithTakeover();
}

async function cmdCodexOAuth(agent) {
  if (agent !== "codex") {
    throw new Error("oauth command is only supported for codex");
  }
  disableCodexTakeover();
  const changed = resetCodexToOAuth();
  console.log(`codex reset to OAuth: ${changed.authPath}, ${changed.configPath}`);
  await syncProxyLifecycleWithTakeover();
}

async function cmdTakeoverToggle(command, args) {
  const { positionals } = parseOptions(args);
  const [agentRaw] = positionals;
  const agent = normalizeAgent(agentRaw);
  if (!agent) {
    throw new Error(`${command} requires agent: codex|claude-code|cc`);
  }
  const action = command === "enable" ? "enable" : "disable";
  return cmdAgentTakeover(agent, [action]);
}

function parseAgentForRootCommand(command, args) {
  const { options, positionals } = parseOptions(args);
  const [agentRaw] = positionals;
  const agent = normalizeAgent(agentRaw);
  if (!agent) {
    throw new Error(`${command} requires agent: codex|claude-code|cc`);
  }
  return { options, agent };
}

function cmdAgentUnset(agent, args) {
  const { options } = parseOptions(args);
  if (!options.local) {
    throw new Error("unset requires --local");
  }
  const result = cleanupLocalBinding(process.cwd(), agent);
  TerminalUi.printOutput(options, { ok: true, scope: "local", agent, cleanup: result }, (data) => {
    const status = data.cleanup.cleaned ? "cleaned" : `noop (${data.cleanup.reason})`;
    console.log(`${data.agent} local binding ${status}`);
  });
}

async function cmdRootDisable(args) {
  const { options, agent } = parseAgentForRootCommand("disable", args);
  const localCleanup = cleanupLocalBinding(process.cwd(), agent);
  await cmdAgentTakeover(agent, ["disable"], { quiet: asJsonEnabled(options) });
  if (asJsonEnabled(options)) {
    console.log(JSON.stringify({ ok: true, scope: "all", agent, cleanup: localCleanup }, null, 2));
    return;
  }
  const localStatus = localCleanup.cleaned ? "cleaned" : `noop (${localCleanup.reason})`;
  console.log(`${agent} local binding ${localStatus}`);
}

function cmdImport(args) {
  const { options, positionals } = parseOptions(args);
  const [source] = positionals;
  if (!source || source !== "cc-switch") {
    throw new Error("import requires source: cc-switch");
  }

  const agentOpt = options.agent ? String(options.agent).toLowerCase() : "all";
  const targetAgent = agentOpt === "all" ? "all" : normalizeAgent(agentOpt);
  if (!targetAgent) {
    throw new Error("import --agent must be codex, claude-code, cc or all");
  }

  const dbPath = String(options.db || `${process.env.HOME}/.cc-switch/cc-switch.db`);
  const config = loadConfig();
  const result = importFromCcSwitch(config, dbPath, targetAgent);
  saveConfig(config);

  TerminalUi.printOutput(options, { ok: true, dbPath, ...result }, (data) => {
    TerminalUi.renderImportResult(data);
  });
}

async function cmdServe(args) {
  const { options } = parseOptions(args);
  const config = loadConfig();
  const serverConfig = normalizedServer(config, options);
  const takeover = getTakeoverState();
  const proxyOrigin = `http://${serverConfig.host}:${String(serverConfig.port)}`;
  if (takeover.codex) enableCodexTakeover(proxyOrigin);
  if (takeover.claude) enableClaudeTakeover(proxyOrigin);

  await startProxyServer(serverConfig);
  writeProxyRuntime({
    pid: process.pid,
    host: serverConfig.host,
    port: serverConfig.port,
    startedAt: new Date().toISOString(),
  });
  console.log(`apm proxy serving on ${serverConfig.host}:${String(serverConfig.port)} (pid ${process.pid})`);

  const shutdown = () => {
    clearProxyRuntime();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function cmdStart(args) {
  const runtime = readProxyRuntime();
  if (runtime?.pid && isPidAlive(runtime.pid)) {
    console.log(`apm proxy already running on ${runtime.host}:${String(runtime.port)} (pid ${runtime.pid})`);
    return;
  }

  const { options } = parseOptions(args);
  const config = loadConfig();
  const serverConfig = normalizedServer(config, options);
  const result = await checkPortAndService(serverConfig.host, serverConfig.port);
  if (!result.available) {
    if (result.isApmService) {
      console.log(`apm proxy already running on ${serverConfig.host}:${String(serverConfig.port)}`);
    } else {
      console.error(`port ${serverConfig.port} is already in use by another process`);
    }
    return;
  }

  const script = path.resolve(process.argv[1]);
  const child = spawn(process.execPath, [script, "serve", ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`apm proxy starting (pid ${child.pid})`);
}

function cmdStop() {
  const runtime = readProxyRuntime();
  const takeover = getTakeoverState();
  if (!runtime?.pid || !isPidAlive(runtime.pid)) {
    clearProxyRuntime();
  } else {
    process.kill(runtime.pid, "SIGTERM");
    clearProxyRuntime();
    console.log(`apm proxy stopped (pid ${runtime.pid})`);
  }

  if (takeover.codex) {
    const changed = disableCodexTakeover();
    console.log(`codex config restored: ${changed.authPath}, ${changed.configPath}`);
  }
  if (takeover.claude) {
    const changed = disableClaudeTakeover();
    console.log(`claude-code config restored: ${changed.settingsPath}`);
  }
}

function cmdStatus(args) {
  const { options } = parseOptions(args);
  const config = loadConfig();
  const runtime = readProxyRuntime();
  const takeover = getTakeoverState();
  const running = Boolean(runtime?.pid && isPidAlive(runtime.pid));
  const server = `http://${config.server.host}:${String(config.server.port)}`;

  const buildForAgent = (targetAgent) => {
    const local = readLocalBinding(process.cwd(), targetAgent);
    const globalProvider = getActiveProvider(config, targetAgent);
    return {
      agent: targetAgent,
      local,
      global: globalProvider,
      server,
    };
  };

  const codex = buildForAgent("codex");
  const claudeCode = buildForAgent("claude-code");

  const data = {
    proxy: {
      running,
      pid: running ? runtime.pid : null,
      host: running ? runtime.host : null,
      port: running ? runtime.port : null,
      startedAt: running ? runtime.startedAt : null,
    },
    takeover: {
      codex: Boolean(takeover.codex),
      "claude-code": Boolean(takeover.claude),
    },
    failover: {
      codex: Boolean(config.agents.codex?.failover?.enabled),
      "claude-code": Boolean(config.agents["claude-code"]?.failover?.enabled),
    },
    current: {
      codex,
      "claude-code": claudeCode,
    },
  };

  TerminalUi.printOutput(options, data, () => {
    TerminalUi.renderStatus(data);
  });
}

function cmdLogs(args) {
  const { options } = parseOptions(args);
  const lines = Number(options.lines || 20);
  const follow = Boolean(options.follow);
  const tail = readLastProxyLogs(Number.isFinite(lines) && lines > 0 ? lines : 20);

  for (const item of tail) {
    TerminalUi.renderProxyLog(item, formatProxyLog(item));
  }
  if (!follow) return;

  const filePath = getProxyLogPath();
  let offset = 0;
  try {
    offset = fs.statSync(filePath).size;
  } catch {
    offset = 0;
  }

  const timer = setInterval(() => {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return;
    const fd = fs.openSync(filePath, "r");
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    fs.closeSync(fd);
    offset = stat.size;

    const linesRaw = buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of linesRaw) {
      try {
        const obj = JSON.parse(line);
        TerminalUi.renderProxyLog(obj, formatProxyLog(obj));
      } catch {
        // ignore malformed line
      }
    }
  }, 800);

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseEntrypoint(argv) {
  const [first, second, ...rest] = argv;
  const maybeAgent = normalizeAgent(first);
  if (maybeAgent) {
    return {
      agent: maybeAgent,
      command: second,
      args: rest,
    };
  }
  return {
    agent: null,
    command: first,
    args: [second, ...rest].filter((item) => item !== undefined),
  };
}

export async function runCli(argv) {
  const { agent, command, args } = parseEntrypoint(argv);

  if (!command || command === "--help" || command === "-h") {
    TerminalUi.printHelp();
    return;
  }

  if (!agent) {
    if (command === "list") return cmdRootList(args);
    if (command === "rename") return cmdRename(args);
    if (command === "enable") return cmdTakeoverToggle(command, args);
    if (command === "disable") return cmdRootDisable(args);
    if (command === "import") return cmdImport(args);
    if (command === "start") return cmdStart(args);
    if (command === "serve") return cmdServe(args);
    if (command === "stop") return cmdStop(args);
    if (command === "status") return cmdStatus(args);
    if (command === "logs") return cmdLogs(args);
    throw new Error(`unknown command: ${command}. write commands must use: apm <agent> <command>`);
  }

  if (!AGENTS.includes(agent)) {
    throw new Error(`invalid agent: ${agent}`);
  }

  if (command === "add") return cmdAgentAdd(agent, args);
  if (command === "update") return cmdAgentUpdate(agent, args);
  if (command === "list") return cmdAgentList(agent, args);
  if (command === "show") return cmdAgentShow(agent, args);
  if (command === "remove") return cmdAgentRemove(agent, args);
  if (command === "use") return cmdAgentUse(agent, args);
  if (command === "unset") return cmdAgentUnset(agent, args);
  if (command === "test") return cmdAgentTest(agent, args);
  if (command === "failover") return cmdAgentFailover(agent, args);
  if (command === "enable") return cmdAgentTakeover(agent, ["enable"]);
  if (command === "disable") return cmdRootDisable([agent]);
  if (command === "oauth") return cmdCodexOAuth(agent);
  throw new Error(`unknown ${agent} command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
