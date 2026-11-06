# 管理项目知识

先 `vczh init`，再用 `vczh kb list --kind knowledge` 或 `--kind learning` 检查已有条目摘要及 freshness，选中后用 `vczh kb show <id> --kind <类型>` 阅读正文。current 仅表示来源文件内容未变，不等于结论必然正确；stale 要重新阅读来源；hypothesis 是假说，deprecated 是已废弃。文件改名或删除也会标成 stale。

创建输入 JSON：

```json
{
  "id":"module-contract",
  "title":"模块契约",
  "summary":"何时阅读、这条知识解决什么问题",
  "body":"# 模块契约\n\n事实与边界、选择理由、正反例、验证方式。使用仓库相对路径。",
  "status":"confirmed",
  "sources":[{"path":"src/module.mjs"}],
  "taskIds":["t-来源任务ID"]
}
```

用 `vczh kb put --kind knowledge --file <json>` 保存事实，`--kind learning` 保存经验。同 ID 表示更新：来源内容指纹和核对时间更新，来源任务去重累计。没有来源任务的独立知识维护可传空数组。来源路径必须是现存仓库内普通文件，不能是符号链接或越界路径。

知识以有机器元数据的 Markdown 存在 `.github/vczh/KnowledgeBase` / `Learning`，命令同步生成 Index.md。正文可写 API 选择、模块设计、SOP、决策原因；SOP 与执行结果分开，结果仍在 TaskLogs。不要覆盖命令维护的元数据或索引；更新走 put。

提炼时对照实际代码，而不是盲信聊天文本。用户偏好写清条件、反例和例外；废弃知识保留状态与替代条目，不悄悄删除其历史证据。大型项目用正文链接组织模块专题，不把所有细节塞入索引。
