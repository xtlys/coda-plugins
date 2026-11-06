# 提案与反证

读当前任务与相关知识，先确定根因假说和所属层。每个候选说明预期作用、影响范围、验证方法和什么证据会否定它。一个明确方案即可，不为格式编造多个候选。复杂实验的细节写在任务目录中的 Markdown，并在 summary 中引用。

```json
{
  "summary":"证据指向什么；为什么选择此方案",
  "candidates":[{"id":"p1","title":"候选方案","rationale":"根因、作用和边界","verification":"验证命令或实验；会否定它的现象"}],
  "selected":"p1"
}
```

`vczh task record <id> --file <文件>` 后答复 workflow_task completed。实验结果在后续记录中标明证实、否定或用户否定。需要回退实验时只处理自己的变更，不复制原作者强制全仓回滚和 push 的策略。
