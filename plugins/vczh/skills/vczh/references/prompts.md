# 规范管理

内置规范只有通用 `general` 和 C++ `cpp` 两个维度。每个维度有主题目录，每个主题有规范条目。`prompt list` 返回主题 ID；`prompt show <id>` 输出全部主题，`prompt show <id> --topic <主题id>` 只输出该主题。

保留条目采用原文片段，不概括重写。每段有原提交和行号；移除专属示例的片段明确标记。Prefer X over Y、否定项、原因、例外按保留范围一起维护，不把单向规则补成虚构的正反例，不把库特有规则转译为标准库规则。

项目创建规范：

1. `vczh prompt template <id>` 生成 schemaVersion 2 模板。scope 选择 general、cpp、language 或 project；language 要填写 language 字段。
2. topics 定义主题目录，sections 的 topic 引用目录 ID。条目 body 使用原文风格的 Markdown，包含做法、同一边界的反面做法、原因与必要例外。确有帮助时添加示例；sources 填真实来源，不把项目偏好署名为上游原文。
3. `vczh prompt put --file <json>` 写入 `.github/vczh/prompts`，`vczh prompt enable <id>` 启用。
4. `prompt list/show/disable` 浏览或停用。原有 schemaVersion 1 和没有 topics 的 schemaVersion 2 项目规范仍可用。

内置 ID 与旧版已移除的内置 ID 不允许由项目覆盖。升级时旧内置启用项不再生效，init 或下次启停规范时清理配置；不删除用户自己的知识和规范文件。内置更新由开发者核对来源、四维分类和提取结果后随插件发布；学习计数不自动修改内置规范。
