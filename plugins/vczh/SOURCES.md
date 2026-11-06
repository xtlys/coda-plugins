# 来源与提取边界

以本地第一次克隆的固定版本为基线，不混用不同时间的内容。

| 仓库 | 固定提交 | 用途 |
| --- | --- | --- |
| [Tools](https://github.com/vczh-libraries/Tools/tree/493f3fe00b4a48831c1cc0612184fde709bafcb2) | `493f3fe00b4a48831c1cc0612184fde709bafcb2` | Copilot 共享协议与规范 |
| [Release](https://github.com/vczh-libraries/Release/tree/4b8b30d32706caf229e736e8e49109590ba1e897) | `4b8b30d32706caf229e736e8e49109590ba1e897` | 使用共享材料的样本 |
| [GacUI](https://github.com/vczh-libraries/GacUI/tree/af56a5be836c10779ea910e9cfa2b0459a12dd07) | `af56a5be836c10779ea910e9cfa2b0459a12dd07` | 项目约定、学习和 Jobs 的实例 |

## 四维分类、两维分发

原来的 13 份 Guidelines 已在开发仓库按通用、C++、vczh-libraries、toolchain 分类，每个维度下再按主题组织。完整分类在仓库的 `docs/vczh-classification.md`，机器记录与提取定义在 `scripts/vczh/`；这些维护材料不属于插件安装包。

插件只携带 `prompts/general.json` 和 `prompts/cpp.json`。每个条目保存原文片段、SHA-256、原文件行号与删节标记。主题和条目名称、适用说明是插件添加的导航信息，不冒称上游文字。

- 原文中的否定项、Unless 条件、原因和适用范围随保留规则一起保留。
- 混合句仅删除具体库示例或工具前提，不把库类型替换成另一套类型。
- 匿名 namespace 的禁令依赖合并发布；反射接口禁止 const 依赖原库；均不归入通用 C++。
- Pimpl 与 RAII 保留原有例外；C++20 版本范围保留；MVVM 只提取框架无关职责；25 次复测保留为作者的工程偏好。
- 原文重复段落、截断句和 LSP 表述未借分类之名纠正。

不再分发完整混合 Guidelines、旧规范包、原库工具脚本或初始化同步脚本。保留条目的源文件指纹在 [manifest](upstream/manifest.json) 的 conventionSources 中；未分发来源不能经 source 命令加载。

## 工作流与知识库

upstream 只保留共享入口和六份工作 prompt，共 8 个经过范围裁剪的协议文件。它们不是逐字节完整上游副本：

- 删除 Jobs、原项目测试应用的部署假设、固定平台工具、构建和脚本清单。
- 规范引用改为 general / cpp；工具改由当前项目 Project.md 提供。
- 归档脚本入口替换为行为等价的 vczh remember。
- 调查步骤、分支、提交回退、review、refine、知识索引结构与命令停止点不变。

每个文件的原始指纹、分发指纹、逐处替换范围、替换内容与原因都记录在 manifest。生成脚本先核对固定源指纹，再应用登记过的改动；未登记的上游变化会使校验失败。

知识和学习继续使用根 Project.md，以及 .github/TaskLogs、KnowledgeBase、Learning。Coda 的请求元数据、主题导航、跨平台归档实现、项目总览是宿主功能，不声称来自作者。

许可证依据：上游 [License](https://github.com/vczh-libraries/License/blob/master/README.md) 将 Tools 源文件与 Release/.github 文件列入 Apache-2.0。插件保留许可证与归因。
