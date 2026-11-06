# 忠实性 review：第一版不符合“先完整复刻”

核对基线为第一版 `54b088e` 及 SOURCES 中固定的 Tools/Copilot 原文。结论是第一版实现了一套受 vczh 启发的流程，不能称为原文复刻。此次按“保留完整协议与规范，只拆分通用及语言内容”修正。

## 发现与修正

| 严重性 | 第一版偏离 | 原文要求与本次修正 |
| --- | --- | --- |
| 高 | `review` 被用于实现后的批准/退回关卡 | 原文 [review.prompt.md](upstream/prompts/review.prompt.md) 是执行前任务审阅，保持用户原话，补 DETAILS、VERIFICATION、REVIEW COMMENTS，处理回复和 CLOSED 标记；已恢复 |
| 高 | 提案阶段选定一个方案后直接实现 | [investigate Step 5](upstream/prompts/investigate.prompt.md) 要逐一验证所有未标记提案；每次保留调查文档、回退实验代码；全否定再提案，多确认则比较选优并重放；已恢复完整 prompt |
| 高 | 缺少 Continue、Report 和用户否定确认方案的明确路由 | 已恢复 UPDATE/REPORT 的逐字追加、DENIED BY USER、Continue 直达 Step 5，以及 Report 比较后停止 |
| 高 | 固定 JSON 阶段记录代替调查 Markdown，且“需求原意”可被概括 | 已恢复固定 Copilot_Investigate.md 的标题结构、原始问题全文、TEST 标记、编号方案和逐条 CODE CHANGE；Coda JSON 仅记命令路由，不做证据闸门 |
| 高 | 弱化提交推送与实验回退，缺少多任务逐个提交及 rebase 规则 | 完整保留原文检查点、每个 Task 后提交推送、冲突处理、生成文件再生成、代码变化后重测。用户显式覆盖与工具权限按宿主规则处理 |
| 高 | 自动追加 refine，用 task ID 去重计数并永久保留日志 | [refine.prompt.md](upstream/prompts/refine.prompt.md) 是独立命令：最早一组归档去重、分三份学习文件、按原规则累加/保留计数并排序、删除已消费归档；已恢复 |
| 高 | 知识库只剩平面条目及自动索引 | [kb.prompt.md](upstream/prompts/kb.prompt.md) 的 Topic/Ask/Draft/Improve/Execute、固定草稿结构、保留前文、全文落稿、多级索引均已恢复；[kb-refine](upstream/prompts/kb-refine.prompt.md) 只更新现有知识 |
| 中 | 自增最多三轮评审、强制交付/PR、命令收据与代码指纹 | 原文没有这些闸门，已从主流程移除；保留原文自身的验证、自审、提交要求 |
| 高 | 通用与 C++ 规范概括改写，遗漏匿名 namespace、Pimpl、类型与格式、可选值、反射、25 次、Workflow、Wasm 等 | 13 份 Guidelines 全文逐行纳入分类；正文直接引用原文，不添加虚构正反例或新例外。库专用上下文明确标记 |
| 中 | 仅用 `.github/vczh` 代替原知识目录，缺少原学习文档入口 | 恢复根 Project.md 及 `.github/TaskLogs`、KnowledgeBase、Learning；面板直接读取原文格式，第一版资料保留为旧版浏览 |
| 中 | 未完整执行原 AGENTS 的默认路由与 TODO_TASK 处理 | 六个首词命令、非编码例外、空 repro/review、仅文件标签展开均恢复；最新消息独立保存，恢复不重新初始化 |

## 当前完整性边界

本次完整保存并执行的是固定提交的共享协议和规范。Coda 运行接线、插件规范管理与本地项目总览是宿主功能，并非声称出自作者。项目特定的源码、既有知识正文和 GacUI Jobs 不会被复制到其他工程；语言、构建入口和生成物目录由该工程自己的 Project.md 给出。

本次保留作者原句中的不完美，包括拼写、重复、截断和可能有争议的偏好；没有继续做“通用化改良”。C++ 文本中的具体库条件也不会被转译为另一种语言的未经作者认可的规则。

## 验证结果

- 34 份原文与本地固定提交逐字节对应，并保存 SHA-256。
- 自动检查全部 13 份 Guidelines 每行分类恰好一次，六份工作 prompt 在运行协议中完整出现。
- 15 项专项测试通过：最新请求路由、TODO_TASK、Continue/Report 不清空旧调查、请求恢复与串行约束、归档、原文知识读取、规范维护边界、面板分页、多工作树统计。
- Coda 当前 `workflow_check` 通过；真实 `bpmn-engine` 跑通七个分支，并恢复等待中的 investigate；真实阶段脚本完成请求，未引入额外阶段。
- 插件契约检查、3 项相关仓库回归检查与 Skill 校验通过。

没有执行真实远端 push/PR，也没有用用户项目运行上游试验回退。自然语言协议的复制与接线验证不能证明所有模型执行都绝无偏离；下一步若要评估，应拿独立的小型项目验收，不再改写这份基线。
