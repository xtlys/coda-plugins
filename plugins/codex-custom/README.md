# Codex Custom

独立的 Codex 运行时，用自定义 provider 运行 DeepSeek 等模型。在 Coda 的 Agent CLI 列表中显示为 **Codex Custom**，Agent ID 为 `codex-custom`。

| 项目 | 位置 |
| --- | --- |
| 命令入口 | `~/.local/bin/codex-custom` |
| 原生二进制副本及资源 | `~/.codex-custom/runtime/<版本-平台>/` |
| 配置与密钥 | `~/.codex-custom/config.toml` |
| 模型列表 | `~/.codex-custom/models.json` |
| 会话、日志、SQLite 状态 | `~/.codex-custom/` |

## 准备独立运行时

在本仓库根目录，用 Node 24 或更新版本运行：

```sh
node scripts/install-plugins.mjs codex
node plugins/codex-custom/scripts/install.mjs --codex-plugin plugins/codex
```

安装脚本从 `codex` 插件锁定的 npm 依赖中复制原生 Codex、辅助程序和资源，保存在独立目录。
其中原生主程序名为 `bin/codex-custom`，同时生成 `~/.local/bin/codex-custom` 启动脚本。
启动脚本先设置 Custom 的环境，再 `exec` 原生副本；从终端直接调用也使用独立配置。
重复安装同一版本保留已有副本；安装新版本保留旧运行时。已有的外部 `~/.local/bin/codex-custom` 会被保留，不会覆盖。

也可以自行提供兼容 Codex `app-server` 协议的 `codex-custom`。插件先找 `~/.local/bin/codex-custom`，再查运行机 `PATH`。
找不到或启动失败即报错；不会改用官方 CLI。原生协议兼容性随 `codex` 插件锁定的版本维护。

## 配置 DeepSeek 官方 API

确保当前进程环境已有 `DEEPSEEK_API_KEY`，然后运行：

```sh
node plugins/codex-custom/scripts/deepseek.mjs
~/.local/bin/codex-custom --version
```

配置脚本读取一次环境变量，将密钥写入独立 `config.toml` 的 `experimental_bearer_token`，并生成模型列表。
目录权限为 0700，配置和模型文件权限为 0600；密钥不会打印或写进插件源码。后续运行无需继续提供该环境变量。
脚本只初始化空配置，已有 `config.toml` 或 `models.json` 时会保留并退出。

默认模型为 `deepseek-flash`，列表另提供 `deepseek-v4-pro`；连接 `https://api.deepseek.com`，使用 Responses API、API Key 认证。
模型元数据按 [DeepSeek 官方 Codex 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) 配置。
后续可直接编辑独立配置来更换 provider、模型或密钥；也可以自行使用 provider 的 `env_key`。

## 接入 Coda

在 Coda「设置 › 插件 › 从仓库添加…」中，从 `coda-console/coda-plugins` 选择 `plugins/codex-custom`。
本机开发时，来源可以填写本机仓库路径及相应提交；Coda 只读取已提交的文件。
Coda 同时安装它依赖的 `codex` 插件，复用 ACP、会话指令、插话和后台活动的协议适配。
在 Agent CLI 列表选择 **Codex Custom** 后，模型选择来自独立的模型列表。
插件同时监看 `config.toml`、`models.json` 与项目 `.codex/config.toml`。

## 隔离范围

入口和插件都将 `CODEX_HOME`、`CODEX_SQLITE_HOME` 指向 `~/.codex-custom`，固定调用 `codex-custom`。
它们移除继承的官方 API Key、access token、账号来源、provider 覆盖、ACP 调试日志路径和包管理器安装路径。
这样原有官方 Codex 的账户登录、配置、二进制与更新目录保持独立；Custom 不会导入官方 `auth.json` 或接入 `codex-accounts`。
完整环境变量清单在 `agent/runtime.mjs` 的 `officialVariables`。

项目内 `.codex/config.toml` 与 `.agents/skills` 仍按 Codex 原生规则生效；全局 provider 配置应放在 Custom 目录。

`CODEX_HOME` 和 SQLite 状态位置的含义见 [Codex 官方环境变量说明](https://learn.chatgpt.com/docs/config-file/environment-variables#core-locations)。
