# vczh

在 Coda 中执行 vczh 的原文工作流，并分类管理工程规范。此版本纠正第一版的概括与改写：六份工作 prompt 直接读取上游完整原文；规范正文逐行引用原文，只拆分类别。

[本次忠实性 review](REVIEW.md) · [来源与对应关系](SOURCES.md)

## 使用

在项目对话中说「使用 vczh 工作流……」。插件 Skill 先读取当前项目约定，再按最新请求路由。可用 `vczh protocol` 阅读入口。

| 命令 | 原文行为 |
| --- | --- |
| `ask` | 研究分析，不改源码 |
| `investigate repro` | 归档旧调查、逐字保存需求、构造并确认复现、提出方案、逐个实验和回退、选择并重放最佳方案、复验与自审 |
| `investigate continue` | 追加 UPDATE；用户否定已确认方案时标记 DENIED BY USER；从 Step 5 继续 |
| `investigate report` | 追加 REPORT，比较已确认方案；停止后续执行 |
| `review` | 执行前审阅任务文件，保留用户原话，补 DETAILS / VERIFICATION / REVIEW COMMENTS |
| `refine` | 整理最早一组归档，提炼偏好，更新排序计数，删除已消费的归档；一次一组 |
| `kb topic/ask/draft/improve/execute` | 分开研究、追问、起草、改稿、落入索引及正文 |
| `kb refine` | 对照近期学习和代码，更新本项目既有知识页 |

没有首词时，研究问题按 ask、编码按 investigate repro、其他非编码工作直接执行。规划、文档维护、构建/CI 脚本修正属于上游明确列出的非编码例外。空 repro 读取 `TODO_TASK.md`，空 review 标记同一文件。

Coda BPMN 负责路由、交接和恢复；实际步骤按完整原文在发起会话中执行。没有另加证据 JSON 闸门、固定评审轮数、强制 refine 或强制 PR。原文的提交推送检查点、逐 Task 提交、rebase 后重测均保留。PR 只在用户要求时接续 Coda 原生生命周期。

手动入口：

```sh
vczh init
vczh route --file /tmp/latest-request.txt --intent coding
vczh request start --file /tmp/latest-request.txt --intent coding
```

再由会话调用 `workflow_run`，workflow 为 `vczh`，inputs 为 `root` 与 `request`。同一工作区的固定任务文档串行使用。失败或中断恢复原运行，不重新清空调查。请求内的子步骤以 Markdown 为准，Coda 的请求状态只表示本条命令是否完成。

## 原文与分类

内置正文保留英文原句、示例、否定项、例外、重复段落和截断句。中文只用于目录标题及适用上下文。

| 分类 | 内容 |
| --- | --- |
| `general` | 语言无关的工程偏好、DRY、抽象、上游修复、接口、测试与并发判断 |
| `cpp` | C++20、声明、namespace、Pimpl、RAII、生命周期、多线程、跨平台、Wasm；库或工具专用条目标明上下文 |
| `workflow` | Workflow Script 语言及其 C++ AST 生成接口 |
| `vczh-project` | 原作者的目录约束、测试应用策略、构建/运行/调试工具与 GacUI 规范 |

通用包默认启用；工作涉及相应语言或 vczh 库时，Skill 启用并读取对应包。原库规则没有删除，也不会被伪装成所有项目都通用的规则。`vczh source list` 列出原文，`vczh source <路径>` 输出全文。

`vczh prompt template <id>` 创建原文风格的项目规范模板，按主题保存 Markdown 中的 Prefer / DO NOT / 原因 / 例外，不强迫每一条原规则补出虚构的正反例。`prompt put --file …`、`prompt enable/disable <id>` 管理项目版本。旧 schemaVersion 1 自定义规范仍可用。项目接口不能覆盖内置规范；内置由开发者维护源快照、分类和清单后随插件发布。

## 项目文件与面板

```text
Project.md
.github/
  TaskLogs/
    Copilot_Investigate.md
    Copilot_KB.md
  KnowledgeBase/
    Index.md
    Index_<PROJECT>.md
    KB_<PROJECT>_<Category>.md
    KB_<PROJECT>_Design_<Topic>.md
    Learning.md
  Learning/
    Learning_Coding.md
    Learning_Testing.md
    YYYY-MM-DD-HH-mm-ss/Copilot_Investigate.md
  vczh/
    project.json
    prompts/<id>.json
    requests/<id>.json
```

`init` 仅补缺失文件，不覆盖已有文档；初建的 `Project.md` 需要 Agent 根据项目事实填写构建与测试入口。`vczh remember` 是上游归档脚本的跨平台等价操作，保留全文后重置当前标记；`--earliest N` 列出最早归档。

面板直接读取原生 Markdown，展示知识、学习计数、归档、规范和命令状态。只统计本后端登记过的工作区；同一 Git 项目的多工作树取最近登记且可读的一份，不累加分支副本。

第一版 `.github/vczh/KnowledgeBase` 和 `Learning` 仍在「旧版资料」中可读。升级不自动转换旧文档或任务；旧六阶段流程的运行应在升级前结束。原生 Markdown 不要求原版没有的来源指纹或状态字段。

## 验证

```sh
node --test test/plugins/vczh.test.mjs
node bin/check.mjs plugins/vczh
```

存在本地 Coda 运行时，可指定其目录执行真实引擎测试：

```sh
VCZH_CODA_RUNTIME=<运行时目录> \
  node --test test/plugins/vczh-bpmn.test.mjs
```

测试包括原文指纹、13 份 Guidelines 的逐行覆盖、六份完整 prompt、命令路由、归档、原生知识浏览、项目规范与面板；真实引擎覆盖七个命令分支和等待中的恢复。`workflow_check` 另用 Coda 当前读取器校验 BPMN。

这些测试验证协议装载与运行接线，不等于证明任意模型会完美遵循每条自然语言指令。原文可能存在不适用于某项目的偏好，按原文适用条件和用户显式覆盖处理。

插件为 Apache-2.0，保留 [NOTICE](NOTICE)。插件内带共享工作流和规范原文快照，不分发三个参考仓库的源码或具体项目知识正文。
