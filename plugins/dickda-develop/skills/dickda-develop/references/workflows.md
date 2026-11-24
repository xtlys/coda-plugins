# 工作流编排与并发派工约定

## 1. 主控并发派工协议（`DECISION_JSON`）
`dickda-develop` 中的执行主控（`lead`）每轮输出结构化决策 JSON，支持三种核心动作：

- **`dispatch`（并发派发 1..N 个工单）**：
  - 每个工单包含 `id`、`trade`（`architect | builder | verifier`）、`difficulty`（`normal | hard`）、可选 `tier`（`standard | senior`）、`title`、`task`、`lockSpec`（`builder` 默认 `true`，禁止修改 `.dickda/lints` 与已锁定 `.dickda/verifiers`）。
  - BPMN 使用无序并行多实例（`multiInstanceLoopCharacteristics`）在各自独立工作树同时调用 `coda-agent` 执行同批全部工单。
  - 批次结束后自动用 `git merge-tree` 无冲突校验合入需求分支 `dickda/req-<runId>`；发生冲突或违反 `lockSpec` 的工单自动记为被打回并累加 `rejections` 计数。
- **`verify`（进入全量双轨验证）**：所有实现块合齐后调用 `dickda-verify` 并行执行代码验证轨道与 `verifier`（Sol）黑盒/UI 实证轨道，并对整条需求分支执行独立 `review-commit`。
- **`escalate`（向上请示交互者）**：仅在遇到破坏 `PLAN_5L.md` 顶层设计、对外契约变更或高级工程师仍无法消解的阻塞风险时触发，流程挂起 `userTask` 交顶层交互者会话拍板。

## 2. 两级工程师升级逻辑
`roles.mjs` 按以下规则自动解析工单执行人：
1. 工单显式指定 `tier: "senior"`，或标注 `difficulty: "hard"` → 直接选用该工种**高级工程师**；
2. 该工单历史 `rejections >= escalationThreshold`（默认 2 次） → 自动升级选用**高级工程师**，并在工单提示中附带前序失败原因与上一分支参考提交；
3. 其余常规工单选用**常规工程师**。

## 3. 私有交付 PR 与并发隔离
- 同一 Git 仓库共用 `dickda:<projectId>` 宿主独占组（`exclusive=true, borrow=no`），防止并发运行覆写 `.dickda/tasks/`。
- 交付 PR 通过剥离 `CODA_THREAD_ID` 的私有 `gh` 创建与更新，避免重复触发外部独立 PR 生命周期流程。
