---
name: dickda-develop
description: 采用 Dickda 五层倒金字塔开发工作流：以交互者-思考者-执行者（主控/架构/实现/验证，支持两级升级与并发派工）协同推进开发、双轨验证与 refine 五层重构，统一管理 .dickda 工程、测试与知识资产。
---

# Dickda 五层开发工作流

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
    logs/               # 实验调查与主控裁决记录
  lints/                # L2 可执行规约脚本（*.mjs / *.sh，由 dickda lint 执行）
  verifiers/            # L3 结果导向验证资产（代码测试脚本 + Agent/UI 验收规约 *.md/*.json）
  knowledge/            # L4 知识库（Index.md 与领域设计文档）
  learning/             # L4 经验计数（Learning_*.md）与时间戳调查归档
  prompts/              # 项目自定义规范（*.json；内置含 general 与 cpp）
```

## 3. 标准工作流入口

1. **需求开发与交付（`dickda-develop`）**：
   - 交互者与用户对齐需求后，可先生成交互看板（`dickda dashboard --output <path.html>` 配合 `visualize`），再用 `workflow_run`（`workflow: "dickda-develop"`, `confirm: true`）交用户开工；
   - 流程自动串联：**思考者产出 `PLAN_5L.md` → 主控并发派发架构/实现/验证工单（支持自动升级高级工程师） → 双轨验证（`dickda-verify`） → 私有交付 PR 与批准合并 → 自动 `remember` 归档**。
2. **独立双轨验证（`dickda-verify`）**：并行运行 L2/L3 确定性代码检查与 `verifier`（Sol）黑盒/UI 实证验收。
3. **五层重构飞轮（`dickda-refine`）**：读取最早未消费的 `.dickda/learning/<timestamp>` 归档，先由**思考者 + 交互者**思考是否需要重构及落入 L1~L4 哪一层，再交执行层落地重构并精简过时口头规则。

详见 [五层方案规范](references/blueprint.md) 与 [工作流编排说明](references/workflows.md)。
