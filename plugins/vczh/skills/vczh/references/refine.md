# 知识与经验沉淀

运行 `vczh protocol knowledge`。从任务证据提取仍有复用价值的项目事实和用户纠偏，事实进入 KnowledgeBase，偏好及工程经验进入 Learning。先找同义条目并更新，别把每次任务都变成一篇重复文章。

条目应链接本次 task ID；计数是不同来源任务的数量，同一次任务反复提炼不会增加。保留任务日志，不删除失败实验。模型假说使用 hypothesis，不写成 confirmed。

```json
{"summary":"此次提炼及合并了哪些旧条目","documents":[{"kind":"knowledge","id":"模块契约条目ID"},{"kind":"learning","id":"经验条目ID"}]}
```

若没有新的通用价值，允许 `documents: []` 并提供 `noKnowledgeReason`；不要为了完成阶段制造空洞知识。用 `vczh task record <id> --file <文件>` 后答复 workflow_task completed。
