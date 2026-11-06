---
name: vczh
description: 用户要求使用 vczh 工作流、管理项目知识库或按 vczh 正反配对格式创作工程规范时使用。支持调查、实现、评审、沉淀及交付；纯解释协议不会启动开发流程。
---

# vczh 工作协议

这是从 vczh 共享指令提炼、适配 Coda 的协议。用户要求“使用 vczh 工作流”即采用本协议，无须重复确认采用；不要把一次解释或只读审查自动升级成编码任务。

## 路由与上下文

- 只读问题、`ask`：阅读并答复，不初始化、不写文件。
- `review`：审查用户指定材料，不自动修复；实现流程中的 review 按阶段协议执行。
- 知识或经验整理：运行 `vczh protocol knowledge`。
- 规范创建、编辑、启停：运行 `vczh protocol prompts`。
- 开发或缺陷调查：按下面的持久化流程执行。

先读已有 AGENTS.md、Project.md、`.github/vczh/Project.md`。用 `vczh prompt list` 选择已启用规范，再逐项 `vczh prompt show <id>` 阅读；C++ 只在相关项目中显式启用。阅读已有的 `.github/vczh/KnowledgeBase/Index.md` 与 `Learning/Index.md`，再按摘要选读相关条目，核对来源，不全量灌入上下文。项目明确约定优先于插件偏好，过期知识只是线索。

## 开始与恢复

1. 在目标工作区运行 `vczh init`。这是幂等操作，只创建 `.github/vczh` 并登记本地总览，不改现有 AGENTS.md，也不覆盖项目文档。PR 任务若有其他未提交工作，先建立独立工作树；最终交付将核对干净工作区及远端 PR 提交。
2. 若会话已有 task ID / run ID，先 `vczh task show <id>` 并检查对应运行；失败或取消用 `workflow_resume`，正在运行则处理原任务。已完成任务若是新需求，用新 task ID。
3. 新任务把用户需求原意、限制和验收标准写入文件，运行 `vczh task start --title <标题> --file <需求文件> --delivery local`。已有明确创建 PR 的要求时选 `pull-request`。不要因为采用工作流便推断新增外部操作授权。
4. 用 `workflow_run` 启动 `workflow: "vczh"`，`inputs: {root: <init 返回的绝对根目录>, task: <任务 ID>}`。`requestId` 在同一次调用重试时保持不变，流程也按工作区与任务去重。工作在本会话原工作区完成，自动步骤的临时工作区只负责核验。
5. Coda 依次派发阶段任务。用 `vczh protocol <阶段>` 获取自足的操作和证据格式。完成后 `vczh task record <id> --file <证据 JSON>`，再答复 `workflow_task`。不能仅靠文字声称完成；不能直接编辑 task.json 绕过核验。

阶段是 repro → proposal → implementation → review → refine → delivery。review 要求修改时回到 implementation；超过项目的 maxReviewRounds 停止自动循环。代码在 review/refine/delivery 阶段变化时，用 `vczh task revise <id> --reason <原因>` 退回实现，再答复当前阶段任务，让流程重新路由。

## 交接与边界

- 每次实验先记录理由、预期与反证条件。只撤销自己本次实验的明确修改；禁止全仓 reset/clean 或覆盖用户已有变更。
- 检查命令用 `vczh check <任务 ID> -- <命令> <参数...>`，取得检查 ID。核验会比对实际退出码与代码指纹。失败的命令也会留下记录；10 分钟超时可把大检查拆成项目已有的独立入口。
- 需求草稿、证据输入 JSON 放在 `.github/vczh/TaskLogs/<id>/` 或仓库外临时目录；不要把阶段草稿放进源码树，避免它们成为新的待校验输入。
- 证据和检查输出存入 `.github/vczh/TaskLogs/<id>`，知识在 KnowledgeBase，偏好在 Learning，自定义规范在 prompts。需求或日志含秘密时先脱敏，不将秘密写入 Git。
- 默认提交和推送服从项目与用户授权。PR 交由现有 `pull-request` 生命周期继续评审、处理检查和合并；不复制一套自动合并器。Vczh 的 done 表示协议交付完成，PR 链接已交接时不表示 PR 已合并。
- 纯本地完成时汇报结果、验证和知识路径；PR 情况同时汇报链接与交接状态。不要轮询等待 Coda 流程，任务和失败会送回本会话。
- 交付后还有“保存最终任务记录”任务：PR 模式必须把最终状态一同提交并推送，避免工作树回收后丢失证据；本地模式说明仍未提交的内容。
- 归档前代码再次变化，也可 `task revise` 后恢复原运行；运行已经成功结束之后的新需求要创建新任务，不重开旧任务。

规范或数据不符合当前情形时，具体说明冲突并采用用户意图；不要为了填满固定模板创造无用实验、测试或知识。
