# 管理正反配对规范

`vczh prompt list` 查看内置及项目规范，`vczh prompt show <id>` 阅读全文。启用只表示每次本协议会选择读取，普通无关对话不强制加载。general 初始启用，cpp 按项目需要 `vczh prompt enable cpp`；停用用 disable。

创建时先阅读最接近的内置范例，`vczh prompt template <新id>` 取得相同 JSON 格式。与用户的实际需求对齐后填写：

- appliesTo：何时适用、边界是什么。
- prefer：应该怎么做及选择理由。
- avoid：同一决策边界内，不应采取哪些做法。
- examples：成对 good / bad，再以 why 解释区别。
- exceptions：允许例外和项目、用户的覆盖条件。
- checks：可观察的审查问题或验证方法。
- sources：原文链接或项目相对路径，区分原作者观点与本项目调整。

不要只写“写高质量代码”或“不要过度设计”；给能改变具体决策的边界。检验正反例是否在同一问题上做选择，避免不相关的口号。

`vczh prompt put --file <json>` 保存到 `.github/vczh/prompts/<id>.json`，更新用同 ID。默认不自动启用；用户要求本项目采用时，再执行 `vczh prompt enable <id>`。想调整内置规则时以新 ID 创建项目规范并说明覆盖范围，必要时停用被替代的内置包。

general、cpp 是插件开发者维护的内置 ID，项目命令不能覆盖它们。收集到可共享的改进，作为开发者维护任务修改插件 prompts 文件、来源与版本，再验证发布；单个项目不能静默污染全局默认。
