# 交付与 PR 接续

检查代码、项目知识和任务证据是否按项目约定一同交付，更新必要索引。汇报实际通过的验证、未覆盖边界和知识路径。提交前先记录本阶段证据，避免漏掉最终交接记录；后续提交不改变代码内容时不会使代码指纹失效。

本地交付：

```json
{"summary":"交付内容、验证和剩余边界","mode":"local"}
```

任务明确要求 PR 时，按项目规则准备、提交、推送并创建 PR，使用 `gh pr view --json url` 获取完整链接。可评审时交给原生 PR 生命周期；依赖其他 PR、升锁或发布的使用草稿。已有未结束的 pull-request 运行就复用，不能重复启动。只有确实没有自动运行、需要手动评审时才 `workflow_run`，workflow 为 pull-request，pr 为完整 URL。

```json
{"summary":"改动与知识已交付，PR 已交给原生生命周期","mode":"pull-request","pr":"https://github.com/owner/repo/pull/123"}
```

保存并 `vczh task record <id> --file <文件>`，然后答复 workflow_task completed。Vczh 完成不等于 PR 合并，不能提前宣称已上线。合并前验证仍由原生流程步骤或 GitHub 必需检查负责；遵守既有默认分支、批准和发布规则。
