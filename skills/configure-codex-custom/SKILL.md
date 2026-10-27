---
name: configure-codex-custom
description: 配置本仓库 codex-custom 的独立模型上游、API Key 和模型目录，排查第三方 Responses 接口的工具兼容问题，并验证指定模型能够编码和运行测试。
---

# 配置 Codex Custom

适用于本仓库 `plugins/codex-custom` 的本机配置。安装和隔离机制见 [插件说明](../../plugins/codex-custom/README.md)。

## 1. 确认入口并备份

先用 `command -v codex-custom` 定位启动器，再确认它实际调用的二进制及 `CODEX_HOME`。本插件的标准布局：

| 用途 | 路径 |
| --- | --- |
| 启动器 | `~/.local/bin/codex-custom` |
| 原生运行时 | `~/.codex-custom/runtime/<版本-平台>/bin/codex-custom` |
| 上游、认证和默认模型 | `~/.codex-custom/config.toml` |
| 可选模型及客户端能力 | `~/.codex-custom/models.json` |

修改前将两个配置文件备份到本机私有目录；目录权限 0700，文件权限 0600。不要把配置、密钥或备份加入仓库。
启动器会清除继承的官方认证和部分上游环境变量；只设置 `OPENAI_BASE_URL` 或 `OPENAI_API_KEY` 不会改变这里的上游。
已有配置直接增量编辑；`plugins/codex-custom/scripts/deepseek.mjs` 仅用于初始化空配置中的 DeepSeek 官方 API，已有文件时会拒绝覆盖。

## 2. 更换上游和密钥

在 Coda 中通过 `workflow_run` 调用 `secret-request`，传入 `name`、`purpose` 和字符串形式的 `fields` JSON。密钥字段示例：

```json
[{"id":"api_key","label":"API Key","type":"secret","required":true}]
```

等待卡片返回 `saved` 和密钥文件路径，将路径交给配置程序消费。不要把密钥原值读入对话、命令行参数或日志；网页登录才使用 `secret-fill`。
配置程序在内存中处理密钥并正确转义为 TOML 字符串，用临时文件替换配置并保持 0600 权限。

先用新凭据请求目标服务的模型列表，确认模型 ID；只输出状态码和必要的模型信息。API 前缀按服务实际路由填写。
本次 relay 使用 `https://relay.evernight.me/v1`，模型列表为 `/v1/models`，生成接口为 `/v1/responses`。

以下是配置片段，不要用它覆盖整个现有文件：

```toml
model = "deepseek-flash"
model_provider = "deepseek"

[model_providers.deepseek]
name = "Evernight Relay"
base_url = "https://relay.evernight.me/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
# experimental_bearer_token 由配置程序写入卡片提供的新密钥。
```

保留已有 provider ID（此处为 `deepseek`），可修改显示名称。除非用户另有要求，保留默认模型和其他设置。
本次保留原有 API 登录设置；密钥写入该 provider 的 `experimental_bearer_token`，不改官方 `~/.codex` 的配置或认证。

## 3. 添加模型并处理工具兼容

在 `models.json` 的 `models` 数组中增添模型，保留原有条目。沿用兼容条目的结构，调整 `slug`、`display_name` 和实际能力。
上下文预算与推理选项应有依据；不要把其他模型的能力直接当作新模型的能力。`model_catalog_json` 继续指向该目录文件的绝对路径。

本次新增 `muse-spark-1.3-contributor`，仅在该条目中设置：

```json
{"apply_patch_tool_type": null}
```

原因是 Muse 请求曾被接口拒绝：

```text
`custom` tools are not supported on this endpoint
```

这里的 `custom` 是 Responses API 的自由文本工具类型，与程序名、自定义 provider 无关。原生 `apply_patch` 使用这种类型；
本次运行时 0.162.1 的该设置只接受 `freeform` 或 `null`，不能改成 `function`。设为 `null` 后不向模型声明该工具，模型仍可通过 shell 写文件、编译和测试。
只调整受影响的模型。此报错不能证明 relay 的所有模型都不支持 custom 工具，也不能确定限制来自 relay 还是实际模型上游。
Code Mode 的 `exec` 也使用 custom 类型；若另行启用，需要重新验证，关闭 `apply_patch` 不代表已解决所有 custom 工具兼容问题。

## 4. 验证用户指定的模型

先校验 TOML、JSON 和文件权限，再为每个指定模型建立独立测试目录，从实际启动器运行，例如：

```sh
codex-custom exec --ephemeral --skip-git-repo-check \
  -m muse-spark-1.3-contributor -C /absolute/path/to/test-dir \
  '编写 C# 原地快速排序，不使用内置排序，并运行当前目录中的测试。'
```

使用适合当前环境的执行权限；测试目录放在仓库外。准备统一测试，保留测试文件，检查模型确实调用了工具、写出代码，并通过 `dotnet run` 编译运行；随后独立复跑。
快速排序测试可覆盖空数组、单元素、重复值、负数、整数极值、随机数组及大规模有序/逆序数组，用 `Array.Sort` 作为测试中的对照结果。

分别报告配置是否加载、模型调用是否成功、程序是否通过测试。若返回 HTTP 503 `No available accounts`，记录为上游账户/容量不可用；有限重试后停止，不能当作程序测试失败，也不要擅自更换模型冒充通过。

2026-10-27 的实测：Muse 关闭上述工具后成功生成 C# 程序，511 组测试及独立复跑均通过；`deepseek-flash` 多次返回上述 503，未生成程序。这是当次结果，不代表服务后续状态。
