---
name: dickda
description: 采用 dickda模式，以交互者-思考者-执行者（主控/架构/实现/验证，支持两级升级与并发派工）协同推进开发、双轨验证与 refine 五层重构，统一管理 .dickda 工程、测试与知识资产。
---

# dickda模式工作流

本插件以**五层倒金字塔（Codebase → Static Analysis → Verification → Prose → Human Review）**为核心，将所有项目配置、任务方案、可执行 Lint、结果导向 Verifier、知识库与经验归档统一收归仓库 **`.dickda/`** 目录管理。

## 1. 三角色 · 四工种体系

使用 `dickda role list` 查看当前生效的模型映射，`dickda role show <角色>` 读取对应极简职责 Prompt：

| 角色 / 工种 | 标识 | 默认常规配置 | 默认高级配置（难任务 / 多次打回升级） | 职责边界 |
| --- | --- | --- | --- | --- |
| **交互者** | `interactor` | `antigravity / gemini-4-neon (xhigh)` | — | 主会话用户沟通、HTML 控制台/图文汇报（`visualize`）、风险与重构拍板 |
| **思考者** | `thinker` | `antigravity / gemini-4-carbon (high)` | — | 制定面向五层抽象的 `.dickda/tasks/PLAN_5L.md`，诊断 `refine` 落层 |
| **执行 · 主控** | `lead` | `antigravity / gemini-4-neon (xhigh)` | — | 并发派发三工种工单、难度/升级裁决、自主采纳或忽略 Review 意见、风险上报 |
| **执行 · 架构** | `architect` | `antigravity / claude-opus-5-5 (high)` | `antigravity / gemini-4-carbon (high)` | L1 架构骨架、L2 `.dickda/lints/` 实现、L3 `.dickda/verifiers/` 设计 |
| **执行 · 实现** | `builder` | `codex / gpt-6.2-astra (high)` | `codex / gpt-6.2-astra (max)` | 复现、实验回退与工程实现（禁止擅改已锁定的 Lint 与 Verifier） |
| **执行 · 验证** | `verifier` | `codex / gpt-6.1-sol (high)` | `codex / gpt-6.1-sol (max)` | 专职找问题、独立 `review-commit` 与黑盒/UI 自动化实证验收 |

## 2. 统一资产目录 `.dickda/`

首次接入项目执行 `dickda init`，所有工程、测试与知识资产统一存放在 `.dickda/`（运行锁与临时状态隔离在工作树私有 `<git-dir>/dickda/`，不随提交扩散）：

```text
.dickda/
  project.json          # 项目标识、已启用规范与验证配置
  project.md            # 构建、测试、预览运行与禁止修改边界
  tasks/
    TODO_TASK.md        # 当前需求逐字原文
    PLAN_5L.md          # 思考者产出的五层技术方案（见 references/blueprint.md）
    logs/<jobId>.md     # 每张并发工单独立记录，交付前聚合归档
    logs/investigate.md # 无工单 ID 时使用
  lints/                # L2 可执行规约脚本（*.mjs / *.sh，由 dickda lint 执行）
  verifiers/            # L3 结果导向验证资产（代码测试脚本 + Agent/UI 验收规约 *.md/*.json）
  knowledge/            # L4 知识库（Index.md 与领域设计文档）
  learning/             # L4 经验计数（Learning_*.md）与时间戳调查归档
  prompts/              # 项目自定义规范（*.json；内置含 general 与 cpp）
```

## 3. 标准工作流入口

`dickda` 和 `dickda-refine` 的目标分支 `base` 须为仓库默认分支，可留空自动读取。要从其他分支开始工作，填写 `branch`。用 `dickda dashboard` 生成自包含的 HTML 控制台，把返回的 `path` 交给 `visualize` 展示。

1. **需求开发与交付（`dickda`）**。交互者对齐需求后，用 `workflow_run`（`workflow: "dickda"`、`confirm: true`）发起流程。思考者只可提交 `.dickda/tasks/PLAN_5L.md` 的改动。交互者向用户讲解五层方案，说明是否建议开工及理由。用户点击「确认开工」后，首轮派单须核对确认卡展示的提交 SHA。已有完整方案也需确认，显式选择 `fast` 时从 `seed.head` 开工。
   - 填写 `device` 时，开工前先用 `resolve-testbed` 解析设备。项目需要提供 testbed 能力，设备名须可解析。
   - 主控续跑时根据最新提交、提交列表与差异统计恢复代码视图。派工里程碑通过 `tell-session` 同步到交互者会话。重派时附上打回原因，有前序提交时带上 `previousHead`。被打回的编码或验证工单须重派通过，或在 `ignoredFindings` 中按 ID 写明不采纳的客观依据。
   - 每张工单写 `.dickda/tasks/logs/<jobId>.md`。交付前 `remember` 聚合日志、需求与方案到同一归档并提交，随后验证归档所在提交。终审要求修改时可派修，或对同一已验证提交逐条记录客观的不采纳依据，将原结论和依据交用户在批准卡裁决。
2. **独立双轨验证（`dickda-verify`）**。启用 Agent/UI 轨且填写了设备时，先解析设备，再并行启动两轨。代码轨运行 L2/L3 检查。Agent/UI 轨检出目标提交查找规约，只在执行规约时独占指定设备。有规约时，通过结论须含非空摘要和至少一项实证证据。无规约时记录跳过。常规和高级验证者均支持本次流程覆盖。
3. **归档提纯（`dickda-refine`）**。取得项目独占锁后，流程拉取最新默认分支，跳过主干已消费的批次。思考者对最早的待处理归档给出具体工单或 L4 条目，交互者选择 L1–L4 重构、仅更新 L4 或保留归档。消费归档须留下实际改动。选择「仅更新 L4」时，执行和修复只可编辑 `.dickda/knowledge/` 下的 Markdown 文档与 `.dickda/learning/Learning_*.md`。
   工程师提交后运行代码验证、项目检查和独立审查。检查失败退回修复，审查未完成可重试或停止。要求修改由交互者派修或写明不采纳依据。私有 PR 通过合并前和 GitHub 检查后，用户批准固定提交合入默认分支。冲突解开后重新检查、审查和批准，暂不合并则保留 PR 与原归档。

详见 [五层方案规范](references/blueprint.md) 与 [工作流编排说明](references/workflows.md)。
