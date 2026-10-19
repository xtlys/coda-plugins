# DeepSeek Harness

Coda 的 `dsh` Agent 插件，运行插件自带的官方 DeepSeek Harness，无需全局安装 CLI。
锁定 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-acp` **0.2.1-rc.2**（2026-10-20 核对的 npm 最新发布）。
默认使用 `deepseek-official` / `deepseek-flash`；[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)
在核对时将该 ID 指向 **DeepSeek-V4.1-Flash-1017**。1017 是服务端模型版本，不是另一个 API 模型 ID。

## 安装与认证

在 Coda「设置 › 插件 › 从仓库添加」中选择本仓库的 `plugins/dsh`，再选择 DeepSeek Harness 创建会话。
Coda 在插件目录里按 `package-lock.json` 安装依赖；使用 Coda 自带的 Node（24 及以上）。

在运行机给 Coda 后端配置 `DEEPSEEK_API_KEY`，或用同一运行机、同一账号的官方 Harness Web 界面保存 API Key。
插件沿用官方凭据解析：`$DSH_HOME/.credentials.yaml` 优先，其次为启动环境、项目 `.env`、`$DSH_HOME/.env`；
默认 `DSH_HOME` 为 `~/.dsh`。无需把密钥写入插件清单或发进对话。

在源码目录中可用插件自带的 CLI 打开原生配置界面：

```sh
npm ci --prefix plugins/dsh --ignore-scripts
node plugins/dsh/scripts/cli.mjs web
```

插件安装后，同一命令中的脚本路径换成安装目录里的 `scripts/cli.mjs`。
`DEEPSEEK_BASE_URL`、代理与模型配置仍由 Harness 处理。新版配置保存在
`$DSH_HOME/profiles/acp/cordis.patch.yml` 和 `$DSH_HOME/cordis.patch.yml`，不再以旧版 `settings.yaml` 为主。

需要在多组地址和密钥之间切换时，安装独立的 [DSH 多上游](../dsh-upstreams/README.md) 插件。
DSH **1.1.0** 提供 `upstream-source` 扩展点：对 `deepseek-official` 路由在每次模型调用时读取整组 `base_url` / API Key，
正在发送的请求保持原配对。接入后不会回退到原生凭据；未安装时继续使用上面的原生配置方式。
该扩展使用原生 Messages 适配器，不转换为 OpenAI Chat Completions 协议。

## Coda 语义

| 能力 | 实现 |
| --- | --- |
| 会话指令 | 只接受 `systemPrompt.mode: append` 的文本块；在原生系统提示词中追加独立、按 Agent 作用域隔离的 section；不插入用户消息，不解释文本中的 `{{…}}`。超过 1 MiB 或模式错误时拒绝建立会话。 |
| 恢复 | `session/load` 对接原生 `session/resume`，保留日志、模型与权限状态，重新挂载本次 MCP 连接，应用本次 Coda 指令；不重复播放历史。 |
| 模型与强度 | 报告上游实际的 provider/model 路由与选择型配置项；默认 Flash 支持 `off`、`low`、`high`、`max`。原生执行固定每轮接收时的设置，后续修改作用于下一轮。 |
| 审批 | `session/set_mode` 对接原生持久化权限预设：只读、工作区写入、完全访问。审批保留原生一次性授权语义，显示操作理由；停止时撤回卡片。 |
| 提问 | 显式挂载原生 `ask_user_question`，将问题转成 ACP `elicitation/create` 表单；支持单选、多选、自定义文本与取消。 |
| 插话 | 仅向正在执行且未取消的原生轮次调用 `steer`；空闲或已经结束时回 `promptRequired`，不自行开启新轮次。 |
| 消息与工具 | 保留上游已提交消息和思考的顺序；补充工具种类、文件位置、标题、todo 计划与压缩状态。图片输入、持久化附件及 stdio/HTTP MCP 使用原生实现。 |
| 后台任务 | 原生命令注册与结束对应 `_coda/wait`；带原始工具调用 ID，并支持精确停止。命令结束唤醒 Agent 时，先报原活动的 `handling`，输出送完再报告结束。 |
| 子 Agent | 按原生子会话报告活动、任务名、实际模型、消息及工具，并继承 Coda 指令。等待后代与处理回信仍归原委派；原委派结束后继续运行使用新 waitId 和相同 childSessionId。停止调用原生分支中断。 |
| 完成 | 识别 Coda 活动扩展的客户端在根 Agent 本轮结束后即可收到完成，尚未结束的子任务继续作为活动登记。普通 ACP 客户端保留上游等待子任务的完成边界，不收到私有活动通知。 |
| 故障 | 已接收输入且执行已结束的类型化服务错误、限流、流中断和超时报 `service_unavailable / accepted`；认证、余额、上下文、参数错误不标记为可重试。关闭原生 LLM 重试插件，由 Coda 统一重试。 |
| 生命周期 | 保留原生 stdin EOF、SIGTERM、取消与持久化清理流程。stdout 只有逐行 JSON-RPC，日志走 stderr。 |

`modes.auto` 对应原生 `workspace-write`（工作区可写，越界询问），`modes.full` 对应 `danger-full-access`。
这是原生权限预设，不额外引入模型审批器。新会话采用 Harness 的配置默认值。

上游 ACP 只发布已提交的消息，因此界面按已提交的消息块更新，不透传可能被丢弃的原始 token 流。
原生 MCP 的资源、提示模板及服务器发起的 elicitation 仍取决于上游支持；本插件的表单桥接面向 Harness 的用户提问服务。
默认 ACP profile 未启用定时调度，插件不宣称能追踪用户自行加入的所有第三方调度器。

## 维护与验证

入口参考 `codex` 插件：在同一 Node 进程中运行锁定依赖，用 `registerHooks` 仅在加载时接入原生 ACP，
不改 `node_modules`。接入点不匹配、profile 没有挂载锁定的 ACP 时启动失败，避免静默丢失 Coda 语义。
`agent/coda.patch.yml` 是最后应用的启动 overlay，不修改用户的 profile 文件。
`agent/upstreams.mjs` 在加载时接入锁定版本的 API Key provider，地址和认证按请求固定在内存中，密钥不进入会话配置或日志。

```sh
npm ci
node scripts/install-plugins.mjs dsh
node --test test/plugins/dsh/*.test.mjs
node bin/check.mjs plugins/dsh --manifest
# 配好运行机的真实 API Key 后可运行：
node bin/check.mjs plugins/dsh --live
```

自动化测试运行真实的官方 Harness 和 ACP，只有模型端点由本地 HTTP/SSE 服务替代；覆盖原生工具、
MCP、多会话隔离、跨进程恢复、审批与提问取消、插话、服务故障、后台命令及子 Agent，并运行完整 Coda 契约检查。
升级时同时更新两个 npm 版本与 lockfile，复核加载接入点并运行这些测试；有真实凭据的环境再做线上模型验收。

上游参考：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、
[原生 ACP 契约](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/acp/acp)。
