# DSH 多上游

为 Coda 的 DeepSeek Harness 保存多组 `base_url` 与 API Key，并在资源面板切换。
这是独立插件，参照 `codex-accounts`，通过 `dsh/upstream-source` 扩展点接入。
需要配套 **DSH 1.1.0 或更新版本**；安装、更新时同时选择本仓库同一提交里的两个插件。

## 使用

1. 在「设置 › 插件 › 从仓库添加」中选择 `plugins/dsh-upstreams`；Coda 会同时安装它依赖的 `dsh`。
2. 在运行机的 Coda 会话中执行 `dsh-upstreams configure`，打开命令打印的本地地址。
3. 在网页填写名称、`base_url` 和 API Key。第一个上游自动选用，添加更多上游保留原来的选择。
4. 在「资源 › DSH 多上游」里点「切换使用」。再次填写同一名称会更新它的地址和密钥。

配置网页只监听运行机的 `127.0.0.1`，10 分钟后失效，保存后关闭；须在**运行机的浏览器**打开。
现有 Coda 面板不支持通用配置表单，所以添加、更新使用本地网页，面板提供选择和删除。
在 iPhone 上可以切换已经配置的上游；添加时使用运行机浏览器，或通过下面的文件命令导入。

上游必须兼容 Harness 的 **Messages 协议**。例如官方地址：

```text
https://api.deepseek.com/anthropic
```

Harness 在请求时补上 `/v1/messages`；如果地址已以 `/v1` 结尾，只追加 `/messages`。
这里不将 OpenAI Chat Completions 接口转换成 Messages 接口。模型仍由 DSH 控制，默认 `deepseek-flash`。

## 命令

```sh
dsh-upstreams configure
dsh-upstreams list
dsh-upstreams select "工作"
dsh-upstreams remove "工作"

# 使用已有的私有密钥文件导入；文件只包含 API Key。
dsh-upstreams add --name "工作" \
  --base-url "https://gateway.example.com/anthropic" \
  --key-file "/absolute/path/to/api-key"
```

`list` 只输出 ID、名称、地址和选择状态；`select`、`remove` 接受名称或 ID。
API Key 不接受命令行参数，以免进入 shell 历史和进程列表。导入后是否保留原密钥文件由用户决定。
最多保存 50 个上游。更新同名上游时必须重新提供完整地址和密钥，保持两者配套。

源码中验证或尚未安装插件时，可显式指定插件状态目录和入口：

```sh
CODA_PLUGIN_STATE="$HOME/.local/state/dsh-upstreams" \
  node plugins/dsh-upstreams/scripts/cli.mjs configure
```

此手动状态目录独立于 Coda 安装后提供的目录；要管理 Coda 中的上游，使用 Coda 的 `dsh-upstreams` 命令。

## 切换与存储

- 每次模型调用通过私有管道读取当前上游，并为这一次请求固定地址与密钥；已经发出的请求继续使用原来的配置。
- 正在运行的会话、后续工具调用、子 Agent 和恢复的会话，在下一次模型调用时读取新选择，无需重启。
- 密钥通过原生适配器的认证入口直接提供，不修改 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DSH_HOME`、原生凭据或 profile。
- 安装本插件后，DSH 的 `deepseek-official` 模型路由必须有已选上游。删除当前上游、文件损坏或来源失效时停止请求；不会自动转到其他上游或本机原生凭据。
- 卸载本插件后，新启动的 DSH 进程恢复原生认证方式。其他 provider 和独立 Web Search 的地址、认证不由本插件切换。

插件将完整配置保存在 `CODA_PLUGIN_STATE/upstreams.json`，目录权限 `0700`，文件权限 `0600`。
它是本机私有明文文件，同一系统账号仍可读取。跨进程锁与原子替换让添加、修改、删除和选择不会互相覆盖。
API Key 不进入面板、命令输出、环境变量、模型配置或会话日志。

## 扩展协议与验证

DSH 给来源进程提供它自己的 `CODA_PLUGIN_PATH`、`CODA_PLUGIN_STATE` 和 `CODA_NODE`。
标准输入、输出每行一个 JSON，`selected` 一次返回完整配对：

```json
{"id":1,"method":"selected"}
{"id":1,"result":{"upstream":{"id":"opaque-id","name":"工作","baseUrl":"https://gateway.example.com/anthropic","apiKey":"<private>"}}}
```

失败时返回 `{"id":1,"error":{"message":"原因"}}`。该输出只用于 DSH 与插件之间的私有管道，不在终端运行 `source.mjs` 查看真实凭据。

```sh
npm ci
node scripts/install-plugins.mjs dsh dsh-upstreams
node --test test/plugins/dsh/*.test.mjs test/plugins/dsh-upstreams/*.test.mjs
node bin/check.mjs plugins/dsh-upstreams --manifest
```

测试使用本地 HTTP/SSE 端点和虚构密钥，覆盖完整配对切换、进行中请求、原生凭据优先级、跨进程恢复、
空选择、删除、并发修改、文件权限、面板输出及配置网页的来源校验；无需真实 API Key。
