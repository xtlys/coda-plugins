# 来源与对应关系

依据本地 `vczh/vczh-libraries-Agent工作流与代码规范分析.md` 定位并核对三仓。此次修正仍以第一次交付时实际克隆的固定提交为准，未把不同时间版本混用。

| 仓库 | 固定提交 | 用途 |
| --- | --- | --- |
| [Tools](https://github.com/vczh-libraries/Tools/tree/493f3fe00b4a48831c1cc0612184fde709bafcb2) | `493f3fe00b4a48831c1cc0612184fde709bafcb2` | Copilot 共享协议和规范的权威源 |
| [Release](https://github.com/vczh-libraries/Release/tree/4b8b30d32706caf229e736e8e49109590ba1e897) | `4b8b30d32706caf229e736e8e49109590ba1e897` | 消费共享材料的样本 |
| [GacUI](https://github.com/vczh-libraries/GacUI/tree/af56a5be836c10779ea910e9cfa2b0459a12dd07) | `af56a5be836c10779ea910e9cfa2b0459a12dd07` | 项目约定、学习和 Jobs 的实例 |

## 原文保存

[upstream/manifest.json](upstream/manifest.json) 记录 34 个源文件的路径和 SHA-256。副本与 Tools/Copilot 对应文件逐字节相同：

- `AGENTS.md`、`copilot-instructions.md`、`Project.md`。
- 全部 6 份 `prompts/*.prompt.md`。
- 全部 13 份 `Guidelines/*.md`。
- `Scripts`、`TaskLogs`、`Learning` 的共享脚本与模板，以及两个初始化脚本。

`vczh protocol <mode>` 直接输出完整 AGENTS、共享上下文及所选原文 prompt。工作目标、分支条件、Markdown 结构、提交与回退策略均在原文中维护，不再另写一份缩水版阶段协议。

具体项目知识、项目源码、Jobs 的具体任务、平台运行环境不会拷贝成其他项目的内容；三个参考仓库仍在本地 `vczh/repos`。这些不属于共享协议正文。

## 规范分类

`prompts/*.json` 只存目录元数据和原文行范围，正文由 `sourceText`/`excerpt` 校验指纹后读取。全部 Guidelines 每行在分类中恰好出现一次，没有靠摘要替换，也没有删除原库条件。`copilot-instructions.md` 的 Quality Control 另外列在项目上下文包，执行时共享上下文依然全文可读。

通用、C++、Workflow Script、原项目/工具四类不代表修改原规则。C++ 规范保留 Vlpp 类型、匿名 namespace、Pimpl、所有权、反射、Wasm 的原文；条目目录标明其库、发布布局或工具链前提。正反例及 Unless explicitly instructed 和原条目一起引用。

## Coda 对应层

[adapter.md](skills/vczh/references/adapter.md) 明示仅与宿主接线相关的对应关系：

- Skill/贡献机制替代把共享入口覆盖到其他 Agent 文件；原初始化脚本仍完整保留供核对。
- Coda 按六个原文命令及非编码例外分发；调查内部照原 prompt 连续执行。
- 原知识路径恢复到 `.github/KnowledgeBase`、`.github/Learning`、`.github/TaskLogs`，根目录 `Project.md`。
- `vczh remember` 对应归档脚本，可在无 PowerShell 的平台执行；同秒归档不覆盖旧文件。
- 当前项目的工具及语言从自己的 `Project.md` 读取。原文特指 vczh 库或工具的段落保留原文及适用条件，不杜撰不存在的环境。
- 原文回退前隔离用户并行改动，原文的“其余改动”对应本次实验；用户显式覆盖与宿主权限仍优先，不把“默认不推送”重写成作者的流程。

上游的拼写错误、重复不稳定测试段落、截断句、LSP 的原文表述均保留。本次没有借复刻之名修正作者观点；将来若要调整，应作为另一个明确标记的版本评审。

许可证依据与第一次交付一致：上游 [License](https://github.com/vczh-libraries/License/blob/master/README.md) 将 Tools 源文件与 Release/.github 文件列入 Apache-2.0。许可证与归因保留在插件中。
