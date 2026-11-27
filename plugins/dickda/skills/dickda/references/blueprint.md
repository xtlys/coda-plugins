# Five-Layer Plan 规范（`PLAN_5L.md`）

Thinker（`thinker`）在编码开始前必须输出 `.dickda/tasks/PLAN_5L.md`，按 Inverted Pyramid 杠杆率从高到低规划：

```markdown
# Five-Layer Plan：<需求标题>

## L1 · Codebase（架构、接口与重构）
- 模块职责与依赖方向：
- 核心 API / 类型签名 / 所有权契约：
- 前置结构重构项（如需）：

## L2 · Static Analysis（Executable Spec / Lint）
- 新增或更新的 `.dickda/lints/` 规则：
- 编译期 / 类型 / 静态检查命令：

## L3 · Verification（Outcome-Oriented Verification）
- 确定性 Code Verifier（`.dickda/verifiers/` 脚本或集成测试）：
- Agent/UI Verifier（供 `verifier` 盲测的场景与证据要求）：

## L4 · Work Graph & Prose（并发 Work Order 拆分与精简背景）
- 批次 1（可并发）：`[architect] ...`
- 批次 2（可并发）：`[builder] ...`
- 批次 3（可并发）：`[verifier] ...`
- 仅需保留的领域说明：

## L5 · Human Review
- 用户可感知的核心变化与最终验收锚点：
```

## Refine 向上 Refine 原则
当 `.dickda/learning/` 中的归档暴露重复缺陷或用户纠偏时，Thinker 按以下优先级定层：
1. **能通过改进 API/类型杜绝** → 落 **L1**（开架构重构 Work Order）；
2. **能通过 AST/文本/依赖扫描抓出** → 落 **L2**（新增 `.dickda/lints/` 脚本）；
3. **能通过黑盒/UI 场景锁死** → 落 **L3**（新增 `.dickda/verifiers/` 用例）；
4. **纯领域背景或低频取舍** → 留 **L4**（更新 `.dickda/knowledge/` 下的 Markdown 文档或 `.dickda/learning/Learning_*.md`，并删除已被 L1–L3 覆盖的旧条文）。
