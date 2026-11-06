# 复现与验收标准

读取 `vczh task show <id>`，保留原始需求和约束。寻找最小复现或可观察的功能验收，先阅读已有实现和测试。缺陷调查优先证实失败；新功能可把预期行为变成检查。文档等低影响改动使用相称的检查，不造镜像测试。

用 `vczh check <id> -- <命令> <参数...>` 运行，记录返回的检查 ID。该命令即使失败也有 ID。命令本身不能修改被校验的源码；生成或修改用例之后再运行。

保存证据 JSON，再 `vczh task record <id> --file <文件>`：

```json
{"summary":"实际观察、预期与验收边界","outcome":"reproduced","checks":["c-检查ID"]}
```

`outcome` 为 reproduced（复现缺陷）或 specified（定义功能验收）。确实无法执行复现时可用 unavailable，并提供 `reason` 说明限制、已有证据和替代验证，不把未知写为通过。接下来的实现阶段仍需可执行检查。然后用 workflow_task completed 答复。
