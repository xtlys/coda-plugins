---
name: dickda
description: 采用 dickda Mode，以 Interactor-Thinker-Executors（Lead/Architect/Builder/Verifier，支持 Tier Escalation 与并发派工）协同推进开发、Dual-Track Verification 与 refine 五层重构，统一管理 .dickda 工程、测试与知识资产。
---

# dickda Mode 工作流

本插件以**Inverted Pyramid（Codebase → Static Analysis → Verification → Work Graph & Prose → Human Review）**为核心，将所有项目配置、任务方案、可执行 Lint、Outcome-Oriented Verification、Knowledge Base 与经验归档统一收归仓库 **`.dickda/`** 目录管理。

## 1. 三角色 · 四工种体系

使用 `dickda role list` 查看当前生效的模型映射，`dickda role show <角色>` 读取对应极简职责 Prompt：

| 角色 / 工种 | 标识 | 默认 Standard 配置 | 默认 Senior 配置（难任务 / 多次打回升级） | 职责边界 |
| --- | --- | --- | --- | --- |
| **Interactor** | `interactor` | `antigravity / gemini-4-neon (xhigh)` | — | 主会话用户沟通、HTML 控制台/图文汇报（`visualize`）、风险与重构拍板 |
| **Thinker** | `thinker` | `antigravity / gemini-4-carbon (high)` | — | 制定面向五层抽象的 `.dickda/tasks/PLAN_5L.md`，诊断 `refine` 落层 |
| **Thinker · Heavy Mode · Coordinator** | `thinkerCoordinator` | `antigravity / gemini-4-neon (xhigh)` | — | 综合双方修订稿、裁决分歧并提交定稿 |
| **Thinker · Heavy Mode · Carbon** | `thinkerCarbon` | `antigravity / gemini-4-carbon (high)` | — | 独立初稿、交叉 Review、按意见修订 |
| **Thinker · Heavy Mode · Astra** | `thinkerAstra` | `codex / gpt-6.2-astra (high)` | — | 独立初稿、交叉 Review、按意见修订 |
| **Executors · Lead** | `lead` | `antigravity / gemini-4-neon (xhigh)` | — | 并发派发三工种 Work Order、难度/升级裁决、自主采纳或忽略 Review 意见、风险上报 |
| **Executors · Architect** | `architect` | `antigravity / claude-opus-5-5 (high)` | `antigravity / gemini-4-carbon (high)` | L1 架构骨架、L2 `.dickda/lints/` 实现、L3 `.dickda/verifiers/` 设计 |
| **Executors · Builder** | `builder` | `codex / gpt-6.2-astra (high)` | `codex / gpt-6.2-astra (max)` | 复现、实验回退与工程实现（禁止擅改已锁定的 Lint 与 Verifier） |
| **Executors · Verifier** | `verifier` | `codex / gpt-6.1-sol (high)` | `codex / gpt-6.1-sol (max)` | 专职找问题、独立 `review-commit` 与黑盒/UI 自动化实证验收 |

`heavyThink` 默认 `false`，普通规划及 `dickda-refine diagnose` 继续使用 `dickda.thinker`（Refine 保持单 Thinker JSON 诊断）。开启 **Heavy Mode** 后，Carbon 与 Astra 并发独立出稿 → 并发交叉 Review → 并发各自修订 → Coordinator（默认 Neon）综合定稿，共 7 次模型调用。每阶段收齐并校验两份产物后才继续。三个独立槽位的优先级为本次工作流输入覆盖 > 插件设置 > 内置默认值；所有 `antigravity` 槽位强制 `mode: "full"`，`codex` 默认不带 mode。

**Fast Mode 与 Heavy Mode 互斥**，在 `lane` 创建或推送分支前拒绝冲突。Heavy Mode 即使继承已有 `PLAN_5L.md` 也重新规划，旧方案作为背景；本运行已确认方案的恢复一律直接回到 Lead。Interactor 或用户退回会递增独立的 **Plan Round**（`planRound`，与 Lead 的 `round` 分离），携带最新反馈完整重跑四阶段。只有定稿通过严格后代、仅修改 `PLAN_5L.md` 和 L1–L5 正文门禁后才推送、清除反馈并进入 Plan Confirmation。

中间产物仅存于 `<git-dir>/dickda/heavy-think/<runId>/round-<planRound>/` 和 `CODA_PLUGIN_STATE/runs/<project>/<runId>/heavy-think/round-<planRound>/`，不进入 Git 工作树。同轮同输入指纹可复用已完成阶段；成功产出当前 HEAD 且无新反馈时可幂等返回。格式不完整可同会话补齐一次；普通 Thinker 与 Coordinator 未提交时最多续跑两次完成交付。`dickda dashboard` 展示 Heavy Mode 槽位及最近运行的 Plan Round、Dispatch Round。

## 2. 统一资产目录 `.dickda/`

首次接入项目执行 `dickda init`，所有工程、测试与知识资产统一存放在 `.dickda/`（运行锁与临时状态隔离在工作树私有 `<git-dir>/dickda/`，不随提交扩散）：

```text
.dickda/
  project.json          # 项目标识、已启用规范与验证配置
  project.md            # 构建、测试、预览运行与禁止修改边界
  tasks/
    TODO_TASK.md        # 当前需求逐字原文
    PLAN_5L.md          # Thinker 产出的 Five-Layer Plan（见 references/blueprint.md）
    logs/<jobId>.md     # 每张并发 Work Order 独立记录，交付前聚合归档
    logs/investigate.md # 无 Work Order ID 时使用
  lints/                # L2 Executable Spec脚本（*.mjs / *.sh，由 dickda lint 执行）
  verifiers/            # L3 Outcome-Oriented Verification 资产（代码测试脚本 + Agent/UI 验收规约 *.md/*.json）
  knowledge/            # L4 Knowledge Base（Index.md 与领域设计文档）
  learning/             # L4 经验计数（Learning_*.md）与时间戳 Investigation Archive
  prompts/              # 项目自定义规范（*.json；内置含 general 与 cpp）
```

## 3. 标准工作流入口

`dickda` 和 `dickda-refine` 的目标分支 `base` 须为仓库 Default Branch，可留空自动读取。要从其他分支开始工作，填写 `branch`。用 `dickda dashboard` 生成自包含的 HTML 控制台，把返回的 `path` 交给 `visualize` 展示。

1. **需求开发与交付（`dickda`）**。Interactor 对齐需求后，用 `workflow_run`（`workflow: "dickda"`、`confirm: true`）发起流程。Thinker 只可提交 `.dickda/tasks/PLAN_5L.md` 的改动。Interactor 向用户讲解 Five-Layer Plan，说明是否建议开工及理由。用户点击「确认开工」后，首轮派单须核对确认卡展示的提交 SHA。已有完整方案也需确认，显式选择 `fast` 时从 `seed.head` 开工。
   - 填写 `device` 时，开工前先用 `resolve-testbed` 解析设备。项目需要提供 testbed 能力，设备名须可解析。
   - Lead 续跑时根据最新提交、提交列表与差异统计恢复代码视图。派工 Milestone 通过 `tell-session` 同步到 Interactor 会话。重派时附上打回原因，有前序提交时带上 `previousHead`。被打回的编码或验证 Work Order 须重派通过，或在 `ignoredFindings` 中按 ID 写明不采纳的客观依据。
   - 每张 Work Order 写 `.dickda/tasks/logs/<jobId>.md`。交付前 `remember` 聚合日志、需求与方案到同一归档并提交，随后验证归档所在提交。Final Review 要求修改时可派修，或对同一已验证提交逐条记录客观的不采纳依据，将原结论和依据交用户在批准卡裁决。
2. **独立 Dual-Track Verification（`dickda-verify`）**。启用 Agent/UI Track 且填写了设备时，先解析设备，再并行启动两轨。Code Track 运行 L2/L3 检查。Agent/UI Track 检出目标提交查找规约，只在执行规约时独占指定设备。有规约时，通过结论须含非空摘要和至少一项实证证据。无规约时记录跳过。Standard 和 Senior Verifier 均支持本次流程覆盖。
3. **归档 Refine（`dickda-refine`）**。取得项目独占锁后，流程拉取最新 Default Branch，跳过主干已消费的批次。Thinker 对最早的 Pending Archive 给出具体 Work Order 或 L4 条目，Interactor 选择 L1–L4 重构、仅更新 L4 或保留归档。Archive Consumption 须留下实际改动。选择「仅更新 L4」时，执行和修复只可编辑 `.dickda/knowledge/` 下的 Markdown 文档与 `.dickda/learning/Learning_*.md`。
   工程师提交后运行代码验证、项目检查和 Independent Code Review。检查失败退回修复，审查未完成可重试或停止。要求修改由 Interactor 派修或写明不采纳依据。私有 PR 通过合并前和 GitHub 检查后，用户批准固定提交合入 Default Branch。冲突解开后重新检查、审查和批准，暂不合并则保留 PR 与原归档。

详见 [Five-Layer Plan 规范](references/blueprint.md) 与 [工作流编排说明](references/workflows.md)。
