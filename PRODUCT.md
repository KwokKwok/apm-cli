# PRODUCT.md

## 产品定位

`apm-cli` 是一个本地代理驱动的多 Provider 管理层，服务两个终端客户端：

- `codex`
- `claude-code`

设计目标：

1. 不改变用户原有 CLI 使用习惯（继续用官方 CLI）
2. 由 `apm` 管理上游 Provider 选择、切换、故障转移
3. 支持“全局配置 + 项目级覆盖（Claude）”的生效模型

## 一句话架构

```text
Client(codex/claude-code)
  -> (takeover 修改后的 base url)
  -> apm proxy (127.0.0.1:4891)
  -> selected provider base_url
```

`apm` 本身分为两层：

- 控制面（CLI + 配置文件）
- 数据面（HTTP 代理 + failover + 日志）

## 模块分层

### 1) CLI 入口与命令路由 (`src/cli.js`)

职责：

- 解析 root/agent 命令
- 把命令分发到配置管理、takeover、local binding、proxy 运行时
- 统一 `--json` 输出

关键行为：

- `apm <agent> enable`：开启 takeover，并按状态自动启动代理
- `apm <agent> disable`：
  - 清理当前目录 local 绑定
  - 关闭该 agent takeover
  - 若两个 agent takeover 都关闭，则自动停止代理
- `apm <agent> unset --local`：仅清理当前目录 local 绑定
- `apm status`：输出 proxy 状态 + takeover 状态 + 当前生效解析（原 `current` 已并入）

### 2) 全局配置层 (`src/config.js`)

配置文件：`~/.apm/config.yaml`

核心数据结构：

- `server.host/port`
- `agents.codex / agents.claude-code`
  - `active` 当前全局 Provider
  - `failover.enabled`（该 agent 的 failover 开关）
  - `providers[]` Provider 列表

实现要点：

- 读写时做规范化（防脏数据）
- Provider 路由 ID 生成：`providerRouteId(agent, name)`
  - 用于 local 路由 `/p/<routeId>/...`

### 3) 项目级 local binding (`src/bindings.js`)

职责：

- 在“当前目录”写入/读取/清理 local 覆盖
- 维护 `~/.apm/runtime/bindings.json` 注册表

当前行为：

- 项目根定义为“命令执行目录本身”（不向上查找）
- local 标记检查：`.git` / `package.json` / `.claude` / `.codex`
- `claude-code --local` 写入：`<cwd>/.claude/settings.local.json`
- `codex --local` 直接拒绝（不支持项目级自定义 Provider）

清理策略：

- 优先用 `bindings.json` 做精确还原/删除
- 若无注册记录，走兜底扫描：
  - `.claude/settings.local.json`
  - `.claude/settings.json`（历史兼容）
- 识别 APM 注入痕迹后清理
- 若文件清理后为空对象会删除文件
- `.claude` 目录清空后会自动删除目录

### 4) takeover（用户级配置接管）(`src/takeover.js`)

职责：把用户目录配置切到本地代理。

Codex (`~/.codex`)：

- `auth.json` 注入 `OPENAI_API_KEY=apm-proxy`
- `config.toml` 注入/更新 `model_provider="apm"` 与 `[model_providers.apm]`

Claude (`~/.claude/settings.json`)：

- `env.ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
- 注入 `ANTHROPIC_AUTH_TOKEN=apm-proxy`（若不存在）

安全回滚：

- 接管前做双备份：
  - 用户文件旁 `*.apm.bak`
  - `~/.apm/backups/...`
- 关闭 takeover 时优先还原备份
- takeover 状态保存在 `~/.apm/runtime/takeover.json`

### 5) 代理运行时与探针 (`src/runtime.js`)

- 运行信息：`~/.apm/runtime/proxy.json`
- 健康探针：`GET /__apm/health`
  - Header：`x-apm-service: apm-cli`
  - Body：`{ ok: true, service: "apm-cli", version: "2" ... }`
- `checkPortAndService()` 区分：端口空闲 / 已被 apm 占用 / 被其他进程占用

### 6) 请求代理与 failover (`src/proxy-server.js`)

请求处理流程：

1. `detectAgentFromRequest(req)` 判断请求归属 `codex` 或 `claude-code`
2. 选 Provider：
   - 路由优先：URL `/p/<routeId>/...`
   - 其次 header：`x-apm-provider`
   - 最后全局 active provider
3. 构建 failover 候选队列（仅当当前 agent 的 failover=on）
4. 发起上游请求，必要时重试下一个候选
   - 触发重试状态：`429` / `408` / `5xx`
5. 回传响应并记录日志

Claude 相关处理：

- `GET /v1/models` 直接返回内置可见模型列表（不透传）
- 对 JSON body 中 `model` 进行模型映射（sonnet/opus/haiku/default）

Header 转换：

- codex：上游使用 `Authorization: Bearer <key>`
- claude-code：上游使用 `x-api-key` + 默认 `anthropic-version`

### 7) 日志层 (`src/logs.js`)

日志文件：`~/.apm/runtime/proxy.log.ndjson`

记录阶段：

- `phase=start`：请求进入代理
- `phase=done`：请求完成

字段：

- agent/provider/model/upstream_model/status
- tokens(input/output/cache)
- ttft/tps/duration
- candidates（failover 候选链）

## 关键命令语义

### `use`

- `--global`：设置 `config.yaml` 的 active provider
- `--local`：
  - 仅 `claude-code` 支持
  - 写当前目录 `.claude/settings.local.json`

### `enable`

- 只影响 takeover（用户目录级）
- 自动拉起代理（若未运行）

### `disable`

- 同时做两件事：
  - 清理当前目录 local 绑定
  - 关闭对应 agent takeover
- 如两个 agent takeover 都关闭，自动停止代理

### `unset --local`

- 仅清理当前目录 local 绑定
- 不影响 takeover / 代理进程

### `failover on/off`

- 命令入口是 `apm <agent> failover on|off`
- 实际开关写入 `config.agents.<agent>.failover.enabled`（按 agent 独立）

## 状态模型（status 输出）

`apm status --json` 返回四层：

1. `proxy`：代理进程状态
2. `takeover`：两类 agent 的接管开关
3. `failover`：两类 agent 的 failover 开关
4. `current`：每个 agent 的当前生效解析
   - `local.isApmProxy=true` 时视为 local 生效
   - 否则回退到 `global`

## 数据持久化

```text
~/.apm/
├── config.yaml
├── backups/
└── runtime/
    ├── proxy.json
    ├── takeover.json
    ├── bindings.json
    └── proxy.log.ndjson
```

## 已知约束

1. Codex 不支持项目级自定义 Provider

- `apm codex use ... --local` 会报错
- 依据 Codex project config 的能力边界，产品层面刻意禁止

2. `disable` 的 local 清理只针对“当前命令执行目录”

- 不会递归清理其他项目目录
- 多项目场景建议在对应目录执行 `unset --local`

3. `import cc-switch` 依赖本机 `sqlite3`

## 测试覆盖（当前）

- agent 全局隔离与 status 视图
- cc-switch 导入
- 本地绑定写入/确认门槛
- codex local 拒绝
- unset 的无注册兜底清理
- 代理健康探针识别
