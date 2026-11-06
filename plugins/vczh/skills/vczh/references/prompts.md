# 规范管理

内置规范按 general、cpp、workflow、vczh-project 分类。每个条目引用 upstream 中的原文行，附原提交链接。正例、反例、Prefer X over Y、Unless explicitly instructed 和原因作为同一段一起保留；不要把单向原规则强行补成一对虚构示例，也不添加新的例外来弱化原规则。

项目创建规范：

1. `vczh prompt template <id>` 生成 schemaVersion 2 模板。
2. 在 sections 中按决策主题组织原文风格的 Markdown，包含应该采用的做法、同一边界的反面做法、原因与必要例外。示例确有帮助时添加。保留适用语言/项目边界与真实来源，不能把项目偏好署名为 vczh 原文。
3. `vczh prompt put --file <json>` 写入 `.github/vczh/prompts`，`vczh prompt enable <id>` 启用。
4. `prompt list/show/disable` 浏览或停用；项目 API 拒绝覆盖内置 ID。原有 schemaVersion 1 项目规范仍可读取和编辑。

scope 为 general、cpp、language 或 project；language scope 要填写 language 字段。内置更新由开发者核对来源与分类后随插件发布。学习计数不会自动修改内置规范。
