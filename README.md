# apm-cli

[![Publish to NPM](https://github.com/KwokKwok/apm-cli/actions/workflows/publish.yml/badge.svg)](https://github.com/KwokKwok/apm-cli/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/@kwokkwok/apm-cli.svg)](https://www.npmjs.com/package/@kwokkwok/apm-cli)
[![license](https://img.shields.io/github/license/KwokKwok/apm-cli.svg)](https://github.com/KwokKwok/apm-cli/blob/main/LICENSE)

`apm` 是一个本地代理 + Provider 管理器。功能类似于 [cc-switch](https://github.com/farion1231/cc-switch)，但在功能上有所不同：

- **CLI 优先 (Designed for Agents)**：`apm` 专注于纯命令行体验。无论是 OpenClaw、Hermes 还是你自己开发的 Agent，都可以直接通过 `apm` 快速、透明地切换模型服务商。
- **项目级配置 (Project-level Context)**：当前仅 Claude Code 支持目录级配置。你可以在不同的工程项目里同时使用不同的模型服务商（例如项目 A 使用 Claude，项目 B 使用 GLM）。

### 核心功能

- **本地代理托管**：统一管理 `codex` / `claude-code` 原生客户端的上游请求。
- **Provider 灵活切换**：支持全局 (`global`) 或项目局部 (`local`) 的活动 Provider 管理。
- **故障转移 (Failover)**：内置自动重试机制，支持按优先级排序的 Provider 队列。
- **无感接管 (Takeover)**：自动修改并备份客户端配置，取消接管时自动复原。
- **快速导入**：支持直接导入 CC-Switch 配置。

## 安装

```bash
npm install -g @kwokkwok/apm-cli
apm --help
```

## 快速开始

```bash
# 1) 添加 Provider（按 agent 分开管理）
apm codex add openai-main --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
apm cc add anthropic-main --base-url https://api.anthropic.com --api-key-env ANTHROPIC_API_KEY

# 2) 设置 global 活动 Provider
apm codex use openai-main --global
apm cc use anthropic-main --global

# 3) 开启接管（会自动拉起代理）
apm codex enable
apm cc enable

# 4) 查看当前状态（包含 proxy + takeover + 当前生效结果）
apm status
```

## 常用工作流

### 1) 管理 Provider

```bash
apm <agent> add <name> --base-url <url> --api-key-env <ENV> [--model <id>] [--sonnet <id>] [--opus <id>] [--haiku <id>]
apm <agent> update <name> [--base-url <url>] [--api-key-env <ENV>] [--model <id>] [--sonnet <id>] [--opus <id>] [--haiku <id>]
apm <agent> list
apm <agent> show <name>
apm <agent> remove <name>
```

`<agent>` 支持：`codex` / `claude-code` / `cc`（`claude-code` 别名）

### 2) 切换生效 Provider

```bash
# 切换全局活动 Provider
apm <agent> use <name> --global

# 设置项目目录 local 覆盖（仅 claude-code）
apm cc use <name> --local
```

说明：

- `cc --local` 会写入“当前执行目录”的 `.claude/settings.local.json`
- 若当前目录没有项目标记（`.git` / `package.json` / `.claude` / `.codex`），会要求输入 `Y` 确认
- `codex --local` 不支持（见下文限制）

### 3) 开启/关闭接管

```bash
# 开启某个 agent 的接管
apm <codex|claude-code|cc> enable

# 关闭某个 agent：
# - 关闭该 agent 的 global takeover
# - 清理“当前目录”的 local 绑定
apm <codex|claude-code|cc> disable

# Codex 回到官方订阅 / OAuth
apm codex oauth
```

自动联动：

- 任一 agent `enable` 后，若代理未运行会自动启动
- 所有 agent 都 `disable` 后，若代理在运行会自动停止

### 4) 仅清理项目 local 绑定

```bash
apm <agent> unset --local
# 例如：
apm cc unset -l
```

行为：

- 只清理当前目录 local 绑定，不影响 global takeover
- 若本地文件由 apm 创建并清空后无内容，会删除文件；`.claude` 目录为空时也会删除目录
- 即使 `~/.apm/runtime/bindings.json` 没有注册记录，也会做兜底清理（识别 APM 注入痕迹）

### 5) 故障转移（Failover）

```bash
# 设置某个 agent 的 failover 开关
apm <agent> failover on
apm <agent> failover off

# 维护某 agent 的 failover 队列
apm <agent> failover enable <provider>
apm <agent> failover disable <provider>
apm <agent> failover move <provider> --to <index>
apm <agent> enable
apm <agent> disable
```

机制说明：

- `failover on/off` 是按 agent 独立开关（`config.agents.<agent>.failover.enabled`）
- 仅当对应 agent 的 failover 为 `on` 时，才会使用该 agent 的 failover 队列
- 请求失败状态（429/408/5xx）时会按队列顺序尝试下一个 Provider

### 6) 状态、日志、测试、导入

```bash
# 状态（核心命令）
apm status [--json]

# 列表
apm list [--json]

# 代理日志
apm logs [--lines <N>] [--follow|-f]

# 连通性测试
apm <agent> test <name|--all> [--model <id>] [--inference] [--json]

# 从 cc-switch sqlite 导入
apm import cc-switch [--db <path>] [--agent <codex|claude-code|all>] [--json]
```

`status --json` 结构：

- `proxy`：进程状态（running/pid/host/port）
- `takeover`：各 agent 接管开关
- `failover`：各 agent failover 开关
- `current`：各 agent 当前生效信息（local/global、route/provider、路径）

## 命令总览

```bash
# agent 写命令
apm <agent> add <name> --base-url <url> --api-key-env <ENV> [--model <id>] [--sonnet <id>] [--opus <id>] [--haiku <id>]
apm <agent> update <name> [--base-url <url>] [--api-key-env <ENV>] [--model <id>] [--sonnet <id>] [--opus <id>] [--haiku <id>]
apm <agent> remove <name>
apm <agent> use <name> [--global|--local]
apm <agent> unset --local
apm <agent> failover on|off
apm <agent> failover enable <provider>
apm <agent> failover disable <provider>
apm <agent> failover move <provider> --to <index>
apm codex oauth

# agent 读命令
apm <agent> list [--json]
apm <agent> show <name> [--json]
apm <agent> test <name|--all> [--model <id>] [--inference] [--json]

# root 命令
apm list [--json]
apm status [--json]
apm logs [--lines <N>] [--follow|-f]
apm import cc-switch [--db <path>] [--agent <codex|claude-code|all>] [--json]
apm start [--host <host>] [--port <port>]
apm stop
```

## 数据目录

```text
~/.apm/
├── config.yaml                 # 全局配置（providers/active/failover/server）
├── backups/                    # takeover 前备份
└── runtime/
    ├── proxy.json              # 代理运行时 pid/port
    ├── takeover.json           # takeover 状态
    ├── bindings.json           # 项目 local 绑定注册表
    └── proxy.log.ndjson        # 请求日志
```

## 能力限制（Codex project-level）

- `apm codex use <name> --local` 不支持，会直接报错
- 原因：Codex project config（`.codex/config.toml`）存在 project 层边界，`apm` 不在项目级注入自定义 provider
- 推荐：Codex 使用 `--global` + `apm codex enable`
- 参考：<https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml>

## 常见问题

### 1) 为什么请求完全打不通、日志也没有？

通常是“客户端已指向本地代理，但代理进程没跑”。先检查：

```bash
apm status
```

如果 `takeover` 是 `on` 但 `proxy.running=false`，执行：

```bash
apm cc enable    # 或 apm codex enable
```

### 2) `unset --local` 显示 `noop (not registered)` 怎么办？

如果 local 文件有 APM 注入痕迹，当前版本会自动兜底清理；若仍 `noop`，通常说明该目录本地配置本来就不是 apm 写入/接管。
