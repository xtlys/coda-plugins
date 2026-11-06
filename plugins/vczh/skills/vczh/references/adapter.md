# Coda 与上游协议的对应

`vczh protocol <mode>` 输出本说明、共享上下文和对应工作 prompt。命令分支、调查步骤、知识结构、停止点、提交回退检查点来自固定版本。原库及工具链前提已移除，宿主入口已替换；改动逐项登记在 `upstream/manifest.json`，不能称为上游完整逐字副本。

- `REPO-ROOT` 指 `inputs.root`，`Project.md` 在根目录，任务在 `.github/TaskLogs`，知识库和 Learning 直接在 `.github`。自动脚本仅分发命令与记录 Coda 状态。
- 共享 `.github/prompts/<mode>.prompt.md` 对应 `vczh protocol <mode>`；`vczh source prompts/<mode>.prompt.md` 可单独阅读。无须把插件文件再复制到项目。项目自己的 AGENTS、Project 与已有指令仍须读取。
- 内置规范只有 `general` 和 `cpp`，按维度、主题、条目组织。用 `vczh prompt list` 查看，仅用 `vczh prompt show <id>` 阅读 `enabled: true` 的规范；`--topic <主题id>` 可单独查看主题。用户未要求时，不加载或重新启用已停用规范，也不从旧版规范包或外部上游文件重新自动加载已移除的规范。
- 原库 API、构建器、调试器、编译目标、目录和发布工具的具体要求由当前项目自己的 `Project.md`、AGENTS、Guidelines 等提供。不得假定其他项目具备原作者的库或工具环境。
- `vczh remember` 对应原文的“复制到时间戳 Learning 目录，再重置当前调查标记”；`--earliest N` 列出最早归档。归档没有自动提炼、永久保留或按任务 ID 计数；去重与消费后删除按 refine 协议执行。
- `init` 仅补缺失工作文档，保留已有正文。共享协议和内置规范由插件开发者维护；项目源码、任务、学习、知识和自定义规范由项目维护。Coda 的贡献机制代替覆盖其他 Agent 全局入口的同步脚本。
- 同一项目使用固定任务文件，Coda 的 `hold-group` 以持久化 projectId 为组名，设置 `exclusive=true`、`borrow=no`，从绑定请求直到运行退出都独占该组。恢复运行先重新取得组；同项目的工作树也串行，不同项目可并行。request JSON 记录消息、命令、run ID、绑定路径、组和状态，不替代调查内容、不规定额外证据格式或审查轮数。旧版 `.github/vczh` 资料仍可浏览。
- 保留原文 commit/push、逐 Task 提交、实验后保存调查文档并回退实验改动、重放最佳方案、rebase 后重测。Git 操作前核对改动所有权；必要时先在隔离工作树准备调查基线，避免回退丢失用户并行修改。用户明确指示与宿主权限优先；本次覆盖应记入工作记录。
- 保留范围内的原文拼写、重复、截断句和相互张力不自行改写为新政策。根据完整上下文与用户指示执行；实质冲突无法消解时再提出。

## 运行态与升级

请求、活动指针和锁保存在 `git rev-parse --absolute-git-dir` 返回目录下的 `vczh/`，每个工作树独立。它们不会进入 Git 提交，新克隆和新工作树也不会继承旧占用。项目配置、自定义规范、知识和任务文档仍由仓库管理。

`vczh init` 和 `vczh request start` 会为旧版的 `.github/vczh/requests/`、`active-request.json` 和锁文件补充 `.gitignore` 规则，并从 Git 索引移除已经跟踪的旧运行态。工作区副本保留供追溯，但不再作为运行状态读取。若旧文件存在与工作树不同的单独暂存修改，迁移明确失败，先保存这些修改再重试；不会强制丢弃它们。

升级前先结束或取消仍使用旧存储的运行；需要继续时，从旧请求 JSON 的 `latest` 保留原始需求，创建新请求，按已有 Markdown 继续。不要复制历史请求到私有目录来冒充活动运行。

## 释放活动请求

失败或取消后可以恢复原运行；若决定放弃，用 `vczh request show <id>` 取得绑定的 runId。先调用 `workflow_status` 查看该运行；尚未结束则用 `workflow_cancel` 取消，收到结束通知后再核对状态。取消中的运行仍持有文档，不能提前释放。

把刚取得的 `workflow_status` 状态 JSON 保存到临时文件，执行：

```sh
vczh request abandon <id> --run-status /tmp/vczh-run-status.json --reason "放弃原因"
```

命令核对运行 ID、历史绑定路径 `boundRoot`、请求 ID、终态和活动任务，记录 `abandoned` 及原因，释放请求占用。仓库改名后仍用原运行的状态，不修改其中的 root。未绑定运行的 pending 请求不需要 `--run-status`。不删除或重置任务、知识和学习 Markdown。

状态文件只是核验与审计记录，不能阻止另一会话在查询后恢复原运行。并发隔离由同一 Coda 实例的宿主独占组提供：即使旧任务已经恢复并通过读取校验，新请求也必须等旧运行退出才能绑定；放弃后的旧请求再次读取或绑定会失败。释放后不要恢复旧运行或继续旧任务，后续创建新请求并依据现有文档继续。查询不到原运行时不能把“未知”当作“已停止”。

宿主不支持独占且禁止借用的 `hold-group` 时不能省略该步骤或直接绑定请求；不同 Coda 实例也不能共用一个可写工作区。旧存储中的请求按上面的升级步骤处理，不凭历史快照恢复占用。
