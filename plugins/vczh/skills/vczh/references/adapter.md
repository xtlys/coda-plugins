# Coda 与上游协议的对应

`vczh protocol <mode>` 输出本说明、共享上下文和对应工作 prompt。命令分支、调查步骤、知识结构、停止点、提交回退检查点来自固定版本。原库及工具链前提已移除，宿主入口已替换；改动逐项登记在 `upstream/manifest.json`，不能称为上游完整逐字副本。

- `REPO-ROOT` 指 `inputs.root`，`Project.md` 在根目录，任务在 `.github/TaskLogs`，知识库和 Learning 直接在 `.github`。自动脚本仅分发命令与记录 Coda 状态。
- 共享 `.github/prompts/<mode>.prompt.md` 对应 `vczh protocol <mode>`；`vczh source prompts/<mode>.prompt.md` 可单独阅读。无须把插件文件再复制到项目。项目自己的 AGENTS、Project 与已有指令仍须读取。
- 内置规范只有 `general` 和 `cpp`，按维度、主题、条目组织。用 `vczh prompt list` 查看，再用 `vczh prompt show <id>` 阅读；`--topic <主题id>` 可单独查看主题。不得从旧版规范包或外部上游文件重新自动加载已移除的规范。
- 原库 API、构建器、调试器、编译目标、目录和发布工具的具体要求由当前项目自己的 `Project.md`、AGENTS、Guidelines 等提供。不得假定其他项目具备原作者的库或工具环境。
- `vczh remember` 对应原文的“复制到时间戳 Learning 目录，再重置当前调查标记”；`--earliest N` 列出最早归档。归档没有自动提炼、永久保留或按任务 ID 计数；去重与消费后删除按 refine 协议执行。
- `init` 仅补缺失工作文档，保留已有正文。共享协议和内置规范由插件开发者维护；项目源码、任务、学习、知识和自定义规范由项目维护。Coda 的贡献机制代替覆盖其他 Agent 全局入口的同步脚本。
- 同一工作区使用固定任务文件，请求串行执行。request JSON 仅记消息、命令、run ID 和状态，不替代调查内容、不规定额外证据格式或审查轮数。旧版 `.github/vczh` 资料仍可浏览。
- 保留原文 commit/push、逐 Task 提交、实验后保存调查文档并回退实验改动、重放最佳方案、rebase 后重测。Git 操作前核对改动所有权；必要时先在隔离工作树准备调查基线，避免回退丢失用户并行修改。用户明确指示与宿主权限优先；本次覆盖应记入工作记录。
- 保留范围内的原文拼写、重复、截断句和相互张力不自行改写为新政策。根据完整上下文与用户指示执行；实质冲突无法消解时再提出。
