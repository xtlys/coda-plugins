# Coda 与上游原文的对应

`vczh protocol <mode>` 在本说明后输出完整 `AGENTS.md`、`copilot-instructions.md` 和对应 prompt，正文直接来自固定提交，不做转述。读到的原文是执行协议，本说明仅说明宿主入口与实际项目资源的对应。

- `REPO-ROOT` 指 `inputs.root`，`Project.md` 在根目录，任务文档在 `.github/TaskLogs`，知识库和 Learning 也直接在 `.github`。工作在这个原工作区完成；自动脚本仅分发命令与记录 Coda 状态。
- 原文引用的共享 `.github/prompts/<mode>.prompt.md` 对应 `vczh protocol <mode>` 输出的完整 prompt；共享文件也可用 `vczh source prompts/<mode>.prompt.md` 阅读。共享 Guidelines 原文可用 `vczh source Guidelines/<文件名>` 阅读。它们由插件提供，无须为了满足路径字面值再复制一套到项目；项目自己的同名约定仍须读取。
- 共享规范从 `vczh prompt show` 读取；按原文适用条件组合通用、C++、Workflow Script 及项目/工具规则。项目存在 `.github/Guidelines` 时也读取它。原文涉及的 Vlpp 类型、GacUI、目录、宏和 MSBuild wrappers 没有被改写成普适规则。普通项目由自己的 `Project.md` 给出对应工具；不凭空假定它安装了原作者的库或构建环境。
- 原文中的 “large C++ project” 和 “C++ project ... MSBuild wrappers” 描述原作者工程上下文；迁移到其他语言项目时，项目语言与工具由该项目的 `Project.md` 确定。命令的目标、分支、文件结构和停止点仍逐条执行。
- `copilotRemember.ps1` 可用 `vczh remember` 跨平台执行相同的“复制到时间戳 Learning 目录，然后重置当前调查标记”；`--earliest N` 对应 `-Earliest N`。归档没有自动提炼、永久保留或按任务 ID 计数。重复快照清理和消费后删除按 `refine.prompt.md` 执行。
- 原文要求的工作文档由 `init` 初建，已有正文保留。共享原文由插件版本维护，项目源码、任务、学习、知识和自定义规范由项目维护。Coda 的贡献机制代替 `copilotInit.ps1` 复制并覆盖其他 Agent 的全局入口，避免把插件自身注入到无关会话；原同步脚本也完整保存在 upstream 可供核对。
- 同一工作区使用固定任务文件，Coda 请求串行执行。request JSON 只记最新消息、命令、run ID 和状态，不替代调查内容、不规定额外的证据格式或审查轮数。上一版 `.github/vczh` 的资料保留为旧版资料供浏览，不自动迁移或冒充原文格式。
- 原文的 commit/push 检查点、逐 Task 提交、实验后保存调查文档并回退其余实验改动、重放最佳方案、rebase 后重测都保留。Git 操作前核对当前改动的所有权；必要时先在隔离工作树准备调查基线，使原文的实验回退不会丢失用户并行修改。明确的用户指示与宿主权限仍优先；如本次明确要求不推送，在记录中写明这项覆盖，不能把不推送做成协议默认值。
- 上游文本中的拼写、重复章节、截断句和相互张力原样保留。不要自行把它们“优化”为新的硬性政策；按完整上下文和用户显式指示处理，发现无法消解的实质冲突才提出。
