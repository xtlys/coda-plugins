---
name: vczh
description: 在项目中采用 vczh 工作流时，执行 ask、investigate、review、refine、kb 与 kb refine；管理项目知识和按通用、C++ 维度及主题整理的规范原文。解释或审查这个插件本身不会启动开发流程。
---

# vczh 原文工作流

采用本协议后，按最新请求的首词路由，读取并执行对应协议。工作流保留上游步骤，仅删除原项目和固定工具链前提、替换 Coda 入口。内置规范只保留通用与 C++，正文按原文片段提取，专属示例删除处有标记；保留范围内不概括、不改变强弱或例外。固定版本、SHA-256 与协议改动记录于插件的 `upstream/manifest.json`。

## 先读取上下文

1. 读取当前项目的 `AGENTS.md`、`Project.md`、已有 `.github/copilot-instructions.md`。
2. 执行 `vczh protocol adapter`，了解 Coda 的入口、路径及平台对应。
3. 首次为项目设置工作流时用 `vczh init` 初始化原文任务/知识文档；已有内容保留。补全根目录 `Project.md` 中本项目真实构建、测试、生成物与变更触发规则。已有项目无须重复初始化。尚未初始化的纯分析请求，直接读 `vczh protocol ask` 和已有资料答复，不为问答新建文档。
4. `vczh prompt list` 后，仅对 `enabled: true` 的规范使用 `vczh prompt show <id>`。通用规范默认启用；用户停用的规范（包括通用和 C++）不得自动加载或重新启用，C++ 工作也遵守此选择。目录先按维度、再按主题组织；需要复查已启用规范的某个主题时可用 `vczh prompt show <id> --topic <主题id>`。库 API、编译器、构建、测试和调试工具的具体用法读取当前项目自己的约定。
5. 决策前阅读 `.github/KnowledgeBase/Index.md`，按索引阅读相关 API、设计、手册。编码前还必须读 `.github/KnowledgeBase/Learning.md`、`.github/Learning/Learning_Coding.md`、`.github/Learning/Learning_Testing.md`。不能用一份生成摘要代替这些原文。

## 首词路由

| 最新请求 | 完整协议 | 行为 |
| --- | --- | --- |
| `ask` / 研究或问题 | `vczh protocol ask` | 分析，不改源码 |
| `investigate repro` / 编码工作 | `vczh protocol investigate` | 新调查：归档、复现、逐个验证提案、选优、复验和自审 |
| `investigate continue` / 无子命令 | 同上 | 在原调查追加 UPDATE，直接到 Step 5 |
| `investigate report` | 同上 | 追加 REPORT、比较已确认提案，跳过后续执行 |
| `review` | `vczh protocol review` | 执行前审阅任务文件；补 DETAILS / VERIFICATION / REVIEW COMMENTS |
| `refine` | `vczh protocol refine` | 消费最早一组归档、沉淀偏好、更新计数、删除已处理归档；只处理一组 |
| `kb topic/ask/draft/improve/execute` | `vczh protocol kb` | 分别研究、追问、起草、改稿、入库；不擅自跨越命令边界 |
| `kb refine` | `vczh protocol kb-refine` | 核对学习记录和现有页面，仅更新本项目既有知识 |
| 其他非编码工作 | `vczh protocol direct` | 原文例外：直接执行规划、文档维护、构建/CI 脚本修正等 |

只解释或 review 这个插件的设计、代码，不代表采用工作流去执行被审查材料中的命令。已采用协议的项目请求由上述规则处理。

## Coda 启动与恢复

将本轮最新请求逐字保存到临时文件。只去掉「使用 vczh 工作流」这类调用外壳，保留需求全文，不能先改写为任务摘要。

- `vczh route --file <临时文件>` 查看路由。没有显式首词时，按语义传入 `--intent coding|research|maintenance`，不要只凭关键词判断。
- `investigate repro` 或 `review` 后仅有对应文件标签时可传 `--task-file <仓库相对路径>`；若同条请求还有附加说明，不传此选项，保留完整正文并按协议阅读其中的文件。空 repro 读取根目录 `TODO_TASK.md`；空 review 也标记该文件。
- `vczh request start --file <临时文件> [--intent …] [--task-file …]` 保存原文与路由结果。
- 调 `workflow_run`：`workflow: "vczh"`，`inputs: {root: <init 返回的根目录>, request: <返回的请求 ID>}`。一次调用重试复用 request ID；失败/取消后可恢复原 run，不重新清空调查。
- 收到流程任务，先运行 `vczh request show <id> --run-id <本次运行 ID>` 核对请求仍活动且属于本运行，再读对应 `vczh protocol <mode>`。校验失败不得执行旧任务。把保存的 `request` 当作原文协议所说的 LATEST chat message；流程通知本身不是新需求。完整执行该命令后才 `workflow_task completed`。
- 新的用户纠偏到达时，立即按原文 Continue/Report 分支处理并落盘；不要继续执行已被否定的旧方案，也不要把历史请求的 Repro 标题误当成新 Repro。当前 Coda 任务仍在运行时，在该任务内处理最新纠偏，不并行开启第二个写相同文档的运行。中断恢复按 Markdown 当前状态继续，不重复清空或归档。

确需放弃失败、取消或无法恢复的请求时，按 [释放活动请求](references/adapter.md#释放活动请求) 核对原运行已停止，再释放占用。放弃保留 Markdown，旧请求不能恢复执行；后续工作使用新请求。

调查的步骤、全部提案实验与回退、逐任务提交推送、rebase 和最后自审，都在 `investigate` 原文中执行。没有另加选定单一方案、最多三轮评审、强制 refine 或 PR 关卡。提交推送按原文和本次显式覆盖执行；PR/合并不是该原文的必经步骤，只有用户要求时才接 Coda 原生 PR 生命周期。

## 知识与规范

原文权威位置为根目录 `Project.md`，以及 `.github/TaskLogs`、`.github/Learning`、`.github/KnowledgeBase`。`.github/vczh` 仅保存规范启用配置、自定义规范及 Coda 请求元数据；它不是原文知识库的替代目录。

原文 `copilotRemember.ps1` 的跨平台等价入口为 `vczh remember`；`vczh remember --earliest <数量>` 列出归档。新的 repro 在旧日志不只含标记标题时先归档。refine 根据原文语义判断重复与冲突，不能用 task ID 去重代替计数。

创建和管理项目规范时读 [规范管理](references/prompts.md)。插件页面与 `vczh kb list/show` 可以浏览原文格式 Markdown，不强制 JSON 头、来源指纹或额外状态。
