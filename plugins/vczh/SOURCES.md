# 来源与提炼边界

依据用户提供的 `vczh/vczh-libraries-Agent工作流与代码规范分析.md` 定位来源，于 2026-11-07 实际克隆三个仓库并读取。使用 HTTPS、`--depth 1 --filter=blob:none`，未启用 sparse-checkout，得到当前完整工作树；未递归克隆子模块。参考克隆保留在本仓库的 `vczh/repos/`，通过本地 Git exclude 排除，不分发第三方源码。

| 仓库 | 本次 HEAD | 作用 |
| --- | --- | --- |
| [Tools](https://github.com/vczh-libraries/Tools/tree/493f3fe00b4a48831c1cc0612184fde709bafcb2) | `493f3fe00b4a48831c1cc0612184fde709bafcb2` | Copilot 共享协议和规范的权威来源 |
| [Release](https://github.com/vczh-libraries/Release/tree/4b8b30d32706caf229e736e8e49109590ba1e897) | `4b8b30d32706caf229e736e8e49109590ba1e897` | 共享材料的消费与发布样本 |
| [GacUI](https://github.com/vczh-libraries/GacUI/tree/af56a5be836c10779ea910e9cfa2b0459a12dd07) | `af56a5be836c10779ea910e9cfa2b0459a12dd07` | 项目约定、知识与 Jobs 的实际组织样本，仅用于研究 |

这些提交比原分析文档新。本次核对三份 AGENTS.md 的 SHA-256 均为 `95463c5df7d4dcb2fb9ea8e91b729ec51fa66a0fbd0f5b400376f1567b23b3e7`；Tools 与 Release 的 Guidelines 目录无差异。GacUI 的 Project.md 为 484 行，不能把它的工程路径、生成流程或测试矩阵当作通用约束。

## 原始设计

- [Tools/Copilot/AGENTS.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/AGENTS.md)：关键词路由，先读项目与规范；编码调查使用固定文档交接。
- [copilotInit.ps1](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/copilotInit.ps1)：共享源同步到各仓，项目配置保留本地所有权。
- [investigate.prompt.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/prompts/investigate.prompt.md)：需求、复现、提案、确认/否定和用户纠偏落盘。
- [kb.prompt.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/prompts/kb.prompt.md)、[kb-refine.prompt.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/prompts/kb-refine.prompt.md)：总索引、项目索引、API 选择与设计解释分层；知识更新限定范围。
- [refine.prompt.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/prompts/refine.prompt.md)：完成调查转为带计数的用户偏好与项目经验。
- [Coding.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md)、[Coding_MultiThreading.md](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md)：通过排序偏好、正反边界和明确例外塑造工程判断。

## 采用与改写

| 来源概念 | 本插件采用 | 有意调整 |
| --- | --- | --- |
| ask / investigate / review / refine / kb | Skill 路由与分阶段协议 | 只读请求不创建开发任务 |
| 固定 Copilot_Investigate.md | 每任务独立目录、JSON 状态和证据 | 不覆盖上个任务，不依赖单个共享日志 |
| 先写提案再试验 | proposal 先于 implementation，否定结论留历史 | 不强制试完所有方案，也不自动全仓回滚 |
| 每任务 commit/push | 按已授权交付方式保存最终记录 | 不把采用方法当成推送、合并、发布授权 |
| crash early、正确性优先 | 暴露内部不变量错误、预期失败进入契约 | 对不可信输入和可恢复失败不套用崩溃偏好 |
| DRY、保守抽象、上游根因 | 通用包中的信息唯一性与所有权边界 | 接口破坏性变更须评估真实项目测试与迁移条件 |
| C++ 生命周期、RAII、平台与同步 | 独立 C++ 包 | 不带入 Vlpp 类型、反射、正则、源码合并发布规则 |
| Learning 计数 | 不同来源 task ID 去重计数 | 不把重复运行次数当可信度，不删除原始证据 |
| 项目索引与知识维护 | Markdown 正文、生成索引、来源指纹与状态 | 加入过期提示；当前不复制庞大多仓框架知识树 |
| 共享源覆盖同步 | 内置规范随插件发布，项目自定义独立保存 | 不覆盖 AGENTS.md，不把项目学习自动回灌全局 |

`prompts/general.json`、`prompts/cpp.json` 与 Skill 是基于 Tools 共享材料的中文改写和通用化。代码指纹、命令收据、任务去重、BPMN 核验、工作区总览及来源过期检测是本插件新增的适配机制，不声称来自原作者。

GacUI 仅帮助理解项目化组织，没有复制其源码、Jobs、知识正文、截图或测试资产。实际派生材料以 Tools/Copilot 为源。上游 [许可证说明](https://github.com/vczh-libraries/License/blob/master/README.md) 将 Tools 源文件及 Release/.github 文件列为 Apache-2.0；本插件附带对应许可证和归因。

Coda 侧参考了本机原生 PR 生命周期、当前 `workflow-guide.md` 与运行时插件 Skill 读取契约：保持 BPMN 编排、任务回交、失败恢复和 PR 生命周期分工。未复制 PR 评审与合并实现，亦未把本机路径写进可执行协议。
