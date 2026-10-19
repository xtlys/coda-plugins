# GitHub Copilot

把 GitHub Copilot CLI 接进 Coda。插件入口启动 CLI 的[原生 ACP 服务](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
（`copilot --acp --stdio`），在 CLI 与 Coda 之间转发标准输入输出的 JSON-RPC 消息，接入会话指令并适配最终答复；没有额外 npm 依赖。
资源页的「GitHub Copilot」面板独立读取当前账号额度。

## 安装与登录

1. 在每台运行 Coda 后端的机器上[安装 GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)：

   ```sh
   npm install -g @github/copilot
   ```

   npm 安装需要 Node.js 22 或更新版本。macOS、Linux 也可以使用官方安装脚本：

   ```sh
   curl -fsSL https://gh.io/copilot-install | bash
   ```

   脚本以普通用户运行时默认安装到 `~/.local/bin`。插件先找 `~/.local/bin/copilot`，再找后端 `PATH` 上的 `copilot`。
   用 npm、Homebrew 或自定义目录安装时，请确保后端的 `PATH` 包含 CLI 所在目录。

2. 用运行 Coda 后端的同一个系统账户登录：

   ```sh
   copilot login
   ```

   无法在运行机打开浏览器时，使用 `copilot login --device-code`。如果 CLI 安装目录不在终端的 `PATH`，
   将命令里的 `copilot` 换成它的完整路径，例如 `~/.local/bin/copilot`。

3. 在 Coda 的「设置 › 插件 › 从仓库添加…」填写 `coda-console/coda-plugins`，读取后选择「GitHub Copilot」。
   安装后，在新任务的 Agent 列表中选择「GitHub Copilot」。

开发本插件时也可以填写本机仓库的绝对路径或自己的 fork 地址。Coda 只读取提交中的文件，需先提交插件再读取来源。

插件不代为安装 CLI，登录仍在运行机终端完成。CLI 的认证、配置与升级由运行机管理；Coda 的插件安装会在空间内共享，
CLI 仍需在实际运行会话的每台机器上分别安装和登录。

## 额度面板

在「资源」中查看「GitHub Copilot」。面板沿用本机 CLI 当前登录，每次读取单独启动一个短暂的
`copilot --headless --stdio --no-auto-update --log-level none` 进程，通过 CLI 的
`auth.getStatus` 和 `account.getQuota` 获取身份和剩余额度。无需创建会话、发送提示词，也不读取或复制登录令牌。
聊天入口继续使用原生 ACP，与额度查询互不依赖。

- 显示月度额度、聊天和代码补全的剩余比例；无限额度明确显示「无限量」。
- CLI 明确给出 `tokenBasedBilling` 时区分 AI 额度（AI credits）和旧版高级请求（次）；未给出时只显示通用月度额度和百分比，不猜单位。
- 不把会话 token 用量当成账号剩余额度；缺失或无法读取的额度明确提示未知或查询失败。
- 每次刷新新建查询进程，避免旧进程的账号额度缓存；面板缓存时间为 5 分钟。
- 当前版本不展示 `resetDate`：本机 CLI 1.0.97 返回的该值是已经过去的时间，不能可靠地当作下次重置日期。
- 未登录时提示在运行机终端执行 `copilot login`；CLI 缺失、过旧或查询超时时，Coda 显示读取失败。

查询协议和字段依据 [Copilot SDK 用量与额度文档](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)
及 [官方 RPC 类型](https://github.com/github/copilot-sdk/blob/ad20f9f4319d48000b895c9c4180242c2232e1ab/nodejs/src/generated/rpc.ts#L7445)。
该额度接口在 SDK 中仍标记为 experimental，CLI 升级后应复核。面板不会绕过 CLI 直接请求 GitHub 的内部接口。

## 接入行为

- 模型、模式、工具审批、输出和会话恢复按 CLI 实际声明的 ACP 能力处理。插件不固定模型列表，也不添加自动放行参数。
- 入口声明并接收 Coda 的 `systemPrompt`，只接受 `append` 模式的文本块。CLI 不接受这个参数：新会话第一次普通输入前，
  插件把指令放在独立的 `<coda-session-instructions>` 文本块中；斜杠命令延后到下次普通输入，恢复会话不重复注入完整指令。
- 每次普通输入附带简短的答复约定，包括恢复的旧会话：调用 `task_complete` 时，`summary` 必须包含面向用户的完整答复，
  不能只说「解释了……」；不调用这个工具时，以普通助手消息交付答案。Autopilot 原生就把 `summary` 显示为 Markdown，
  见 [CLI 发布说明](https://github.com/github/copilot-cli/releases/tag/v1.0.6)。指令能指导模型，但插件不猜测或改写答案内容，也不能证明答案充分。
- 末尾成功的 `task_complete` 在 `end_turn` 时转成独立的 `agent_message_chunk`，已有等价正文时不重复添加。
  成功转换后省略对应工具通知，避免遮住最终答复；工具之后还有正文或新工具时，先按原顺序转发工具，不在结束时重放旧摘要覆盖新答复。
  普通正文实时转发；失败、取消和异常退出保留原记录。正常完成时既没有末尾正文也没有摘要，则明确报错，不自动重跑任务。
- 未配置 Coda 的「自动审批」「全部放行」模式映射；不能假定 Copilot 的工作模式就是审批策略。
- Coda 将项目 skills 放在 `.github/skills`，由 Copilot CLI 原生加载。
- 配置变化监测包含 `COPILOT_HOME` 下的 `settings.json`、`providers.json`，`COPILOT_PROVIDERS_CONFIG` 指向的文件，
  以及项目的 `.github/copilot/settings.json`、`.github/copilot/settings.local.json`。
  这些路径与 skills 目录见 [CLI 命令参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)。
- 插件不实现 Coda 的 `_coda/wait` 扩展，因此不单独登记后台命令或子 Agent 的等待项。

## 验收

在仓库根目录运行：

```sh
node bin/check.mjs plugins/copilot --manifest  # 只检查清单，不需要 CLI 或登录
node bin/check.mjs plugins/copilot             # 真实 CLI：握手、新建会话、进程退出
node bin/check.mjs plugins/copilot --live      # 真实账号：回复、取消、按声明检查会话恢复
```

自动化测试使用假的 CLI 验证命令参数、路径选择、会话指令、ACP 生命周期和最终答复处理（摘要转换、正文去重、
工具顺序、恢复会话、空答复、取消及异常退出）；未登录、CLI 不可用、额度查询超时也由隔离测试覆盖。
真实 `--live` 检查需要运行机登录，验证包括指令实际生效、回复、取消和会话恢复。Coda 的安装发现以提交后「读取来源」为准。
