# vczh 开发模式

这是输入框“开发流程”中的 `vczh 开发`（`vczh-develop`），用于日常完整开发与交付。用户选择此模式，表示采用任务审阅、调查、检查、代码评审、可选验收、批准合并、按选择部署发布。不要另起 `kickoff`、`simple`、`vczh` 或 `pull-request`。共享原文仍由 `vczh protocol review/investigate/...` 提供；本文件只规定它们怎样接入 Coda。

## 工作根与上下文

流程从所选分支的已提交内容创建独立调查分支和工作树，在任务中给出路径。全部项目命令在这个根目录执行。原工作树的未提交内容不会被带入，也不会被实验回退。任务、知识、学习和实现通过同一个 PR 交付。工作树保留在插件状态目录 `worktrees/<运行 ID>`，可继续检查；运行产物中的 JSON 仅记录交付进度，不作为项目知识。

开始前依次阅读项目 `AGENTS.md`、`Project.md`、已有的 `.github/copilot-instructions.md`，再读 `vczh protocol adapter`。流程已执行 `vczh init`，只补缺失的原生文档。补全 Project.md 的实际构建、测试、生成物、不可修改文件和验收命令，不捏造项目能力。仅通过 `vczh prompt list` 读取 enabled 为 true 的规范；不能擅自重新启用停用的规范。首次采用 C++ 规范时由用户明确启用 `vczh prompt enable cpp`。

决策前读 `.github/KnowledgeBase/Index.md` 及关联原文；编码前读 `.github/KnowledgeBase/Learning.md`、`.github/Learning/Learning_Coding.md` 和 `.github/Learning/Learning_Testing.md`。新初始化的空文件不等于已经有项目知识，实际知识仍来自源码、测试和用户。

## 任务审阅

首次任务会在输入框消息之前交接；随后到达的用户消息才是最新需求。把其原话逐字保存到 `TODO_TASK.md`。用户指定现有任务文件时读完整正文及同条消息的附加要求，保留原文件，并在 TODO_TASK.md 中完整保留这次交付的输入。已有 TODO_TASK.md 含其他任务时先保留一份归档，不静默丢弃。不要把摘要当作原始需求。

读 `vczh protocol review`，以 TODO_TASK.md 作为其最新消息标记的任务文件。只补充原文规定的 DETAILS、VERIFICATION、REVIEW COMMENTS，遵循多任务结构；不在这一步实现。能根据项目上下文合理决定的内容直接写明；真正无法消解的歧义写评审意见，通过原生提问取得答复，逐字记下真实答复，不代用户回答。

选择开发模式已授权审阅后继续调查，任务审阅结束才答复“已审阅，开始调查”。单独的 `review` 命令仍止于审阅。

## 调查与提交

读 `vczh protocol investigate` 的完整输出。新调查的最新请求是 `# Repro` 加审阅后 TODO_TASK.md 的完整正文。完整执行原文，不用本说明替代它：

- 旧日志不止标记标题时先 `vczh remember`；新 Repro 才重置。恢复运行沿已有 Markdown 继续，不能因为重新收到任务而再次清空。
- 构造实际测试，确认问题可复现，记录成功条件并提交复现基线。
- 实验前记录提案及 CODE CHANGE，逐个实验、记录 CONFIRMED / DENIED；每个实验后只提交调查记录并回退该实验的代码。
- 全部提案判定后选最佳已确认方案重放；全被否定则继续提出方案。最后复验、按项目规范和 Learning 自审，代码再变要重测。
- 多任务逐项完成、提交并推送后再做下一项。调查分支没有单独 PR；原文 push 使用明确的 `git push <HTTPS 仓库地址> HEAD:refs/heads/<任务中给出的调查分支>`。不得推到默认分支。网络或需要拉取导致的失败按原文处理。
- 用户纠偏使用 Continue，反馈逐字追加到 UPDATES；否定的已确认方案改为 DENIED BY USER。Report 只比较并报告，保留停止点，选择“按原文停止”，不自动交付。

普通开发完成后提交本次代码和相关 Markdown，答复“提交检查”。流程将同一提交推送到自己的 `vczh/<运行 ID>` 分支，创建或更新 PR；创建 PR 不带 Coda 会话身份，因此不发布 PR 上报事件，不会触发独立 PR 生命周期。不要自行开 PR 或全局停用 PR 自动运行。

## 检查、评审与验收

项目 `check` 流程运行在交付提交上；随后通过官方 `review-commit` 能力在独立只读会话中审查这个提交。默认使用当前 Agent 的选择，可以在输入框改选评审方。该能力采用评审插件的项目规则与严重程度设置，收到完整任务原文及已有检查证据。它是实现后的代码评审，与原文的任务 review 是两个步骤。

成立的代码评审意见、检查失败或验收反馈写入同一调查的 Continue，按原文补证据、实验、复验后提交。新提交重跑检查和代码评审；没有人为设定三轮上限。未采纳的评审意见必须给出理由，在批准卡完整显示。评审未完成时只能重试或停止，不能当成通过。

选择“单独验收”后，按 Project.md 准备这一提交的真实运行结果。C++/CLI 项目给出程序路径、命令与输出；Mac/iPhone 项目调用对应预览安装能力并等成功。用户验收针对该提交，新提交会使旧验收失效。指定测试设备时仅在验收段占用它。

项目 `premerge` 流程与 GitHub 检查通过后才出现批准卡。只有用户可以批准；只合并到默认分支，默认保留调查提交历史（merge，可在插件设置更改）。合并校验批准的 head，遇冲突回调查修复。仅按批准卡选择对合并后的提交执行项目 `deploy`、`preview`、`release` 流程；发布传入真实更新说明和 `publish=true`。

## 知识与学习的边界

沿用 `.github/TaskLogs`、`.github/Learning`、`.github/KnowledgeBase` 与根目录 Project.md，不建立第二份知识 JSON。

用户显式请求 `ask`、单独 `review`、`refine`、`kb topic/ask/draft/improve/execute`、`kb refine` 或 `investigate report/continue` 时执行对应原文命令，尊重其停止点，未要求交付不自动开 PR。`refine` 仍只消费最早的一组归档；`kb refine` 仍仅更新本项目已有页面。开发完成不强制执行 refine 或 kb execute，不将一次实现虚构为用户长期偏好。
