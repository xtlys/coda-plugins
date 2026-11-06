# 评审与纠偏

对当前 diff、需求和已启用规范做审查，核对行为、接口、测试、生成物和兼容性。自审是默认可用路径；有已授权的独立评审或现有 PR 评审时引用其结论，不能把自审标成外部评审。

```json
{"summary":"结论与剩余风险","decision":"approve","reviewer":"self","findings":[]}
```

发现必须处理的问题，`decision` 设为 changes，findings 中逐项写位置、问题、影响和验证方法。外部评审设 `reviewer: "external"` 并给 `reference` 链接或证据路径。`vczh task record <id> --file <文件>` 后答复 workflow_task completed；流程自动回到实现，重新测试后再评审。

如果实现通过后代码又变了，用 `vczh task revise <id> --reason <原因>`，再答复当前阶段任务。不要直接修改代码后沿用已有通过记录。

修改循环的上限取 `.github/vczh/project.json` 的 maxReviewRounds（默认 3）。到上限先重新审视问题和方案；需要更多轮时按明确授权调整，再恢复原流程。不会无限自动重试。
