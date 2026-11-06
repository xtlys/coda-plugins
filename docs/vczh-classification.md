# vczh 规范四维分类

本文件仅供开发维护，不进入插件安装包。按维度、再按主题组织；插件仅分发通用与 C++。所有行号对应固定提交，空行和标题另计为结构，混合行的删除片段记录在 `scripts/vczh/classification.json`。

来源：https://github.com/vczh-libraries/Tools/tree/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot

保留正文来自原文片段，仅做换行统一、主题重排和专属片段删除；中文标题及适用说明为插件添加。没有把被删的库规则替换为另一套库或标准库规则。

边界：匿名 namespace 禁令源于合并发布，归 toolchain；反射接口禁止 const 归 vczh-libraries；25 次复测归通用；Pimpl、RAII 保留原有例外；MVVM 职责划分归通用，XML 绑定归 vczh-libraries；Workflow Script 是原生态语言，归 vczh-libraries。

| 维度 | 主题 | 插件处理 |
| --- | --- | --- |
| 通用 | 9 | 保留 24 个条目 |
| C++ | 8 | 保留 12 个条目 |
| vczh-libraries | 9 | 不分发正文，仅保留开发审计 |
| toolchain | 8 | 不分发正文，仅保留开发审计 |

## 通用 · 保留

### 正确性与错误处理

- **尽早暴露错误**：[Guidelines/Coding.md:8–8](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L8-L8)。语言无关的工程偏好。
- **静态检查、失败契约与异常恢复**：[Guidelines/Coding.md:21–27](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L21-L27)。语言无关的工程偏好。

### DRY 与抽象

- **避免重复信息，先复用已有实现**：[Guidelines/Coding.md:9–14](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L9-L14)（删去专属片段）。保留 DRY 原则及 AST 抽取条件；移除依赖具体库的构造示例。
- **代码生成的维护成本**：[Guidelines/Coding.md:15–15](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L15-L15)。语言无关的工程偏好。
- **抽象应带来实际收益**：[Guidelines/Coding.md:16–20](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L16-L20)。语言无关的工程偏好。

### 依赖边界与上游修复

- **修复根因并保持依赖边界**：[Guidelines/Coding.md:31–47](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L31-L47)。原文以有单元测试覆盖为前提讨论破坏性变更；不能脱离该上下文。

### 接口、组合与所有权

- **继承、组合、契约和所有权**：[Guidelines/Coding.md:156–163](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L156-L163)、[Guidelines/Coding.md:169–169](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L169-L169)。保留作者对 LSP 的原始表述，不将其改写为教材定义。
- **控制反转与类型分派**：[Guidelines/Coding.md:134–134](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L134-L134)。语言无关的工程偏好。
- **递归组合与流畅接口**：[Guidelines/Coding.md:173–177](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L173-L177)（删去专属片段）。保留组合原则；移除三个原库类型示例。

### 值语义与有效性

- **值的有效性与额外状态**：[Guidelines/Coding.md:90–91](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L90-L91)、[Guidelines/Coding.md:95–96](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L95-L96)。仅保留与语言、库无关的值语义；指针空值规则单列在 C++。

### 并发与异步

- **避免过度线程安全设计**：[Guidelines/Coding_MultiThreading.md:3–3](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L3-L3)。语言无关的工程偏好。
- **保持无锁逻辑简单**：[Guidelines/Coding_MultiThreading.md:14–14](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L14-L14)。语言无关的工程偏好。
- **异步调度与轮询**：[Guidelines/Coding_MultiThreading.md:17–17](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L17-L17)。语言无关的工程偏好。

### 跨平台设计

- **平台能力与公共实现的取舍**：[Guidelines/Coding.md:201–205](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L201-L205)。语言无关的工程偏好。
- **同步方法的跨平台取舍**：[Guidelines/Coding_MultiThreading.md:10–12](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L10-L12)、[Guidelines/Coding_MultiThreading.md:21–21](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L21-L21)。原文 other locks 指自旋锁以外的锁；保留平台性能例外，移除原库线程池特例。

### 调试、验证与故障处理

- **崩溃与猜测失败后调试**：[Guidelines/Coding.md:4–7](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L4-L7)。语言无关的工程偏好。
- **用调试补足信息并约束输出**：[Guidelines/Debugging.md:9–9](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Debugging.md#L9-L9)、[Guidelines/Debugging.md:32–32](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Debugging.md#L32-L32)。语言无关的工程偏好。
- **内存泄漏与不稳定问题**：[Guidelines/Coding.md:209–209](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L209-L209)、[Guidelines/Coding.md:216–219](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L216-L219)、[Guidelines/Coding.md:221–223](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L221-L223)。25 次是作者的工程偏好，保留原文适用表述。
- **不稳定问题的重复原文段落**：[Guidelines/Coding.md:227–231](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L227-L231)。原文重复段落及末尾截断句照录；不据此补造新的规则。
- **以编译器实际输出为准**：[Guidelines/Building.md:34–34](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Building.md#L34-L34)。语言无关的工程偏好。
- **以测试实际输出为准**：[Guidelines/Running-UnitTest.md:58–58](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-UnitTest.md#L58-L58)。语言无关的工程偏好。
- **观察异步测试的实际进展**：[Guidelines/Running-UnitTest.md:95–97](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-UnitTest.md#L95-L97)。语言无关的工程偏好。
- **观察异步命令的实际进展**：[Guidelines/Running-CLI.md:50–52](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-CLI.md#L50-L52)。语言无关的工程偏好。

### MVVM 与可测试性

- **视图职责、逻辑与可测试性**：[Guidelines/GacUIMVVM.md:3–3](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L3-L3)、[Guidelines/GacUIMVVM.md:5–8](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L5-L8)、[Guidelines/GacUIMVVM.md:10–10](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L10-L10)。保留独立于 UI 框架的 MVVM 原则；XML、绑定语法和库对象生命周期不在本条内。

## C++ · 保留

### 声明、头文件与命名空间

- **函数声明与头文件**：[Guidelines/Coding.md:62–67](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L62-L67)。仅适用于 C++；保留原文偏好及前提。
- **实现文件中的命名空间**：[Guidelines/Coding.md:70–71](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L70-L71)。适用于 .cpp 实现文件；原库命名空间特例及 Source 目录约束已分出。

### 格式与类型推导

- **缩进与类型推导**：[Guidelines/Coding.md:81–83](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L81-L83)。仅适用于 C++；保留原文偏好及前提。

### 实现隐藏

- **实现隐藏的使用边界**：[Guidelines/Coding.md:59–61](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L59-L61)（删去专属片段）。保留限制及隐藏平台构造的例外；仅移除依赖原库的示例。

### 所有权与对象生命周期

- **全局对象与显式生命周期**：[Guidelines/Coding.md:144–146](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L144-L146)、[Guidelines/Coding.md:149–149](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L149-L149)（删去专属片段）、[Guidelines/Coding.md:150–150](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L150-L150)。适用于一般 C++ 类型；原库专用类型例外不在本插件中。清理时机由当前项目决定。
- **值所有权与非拥有引用**：[Guidelines/Coding.md:164–166](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L164-L166)（删去专属片段）、[Guidelines/Coding.md:168–168](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L168-L168)。保留值成员、继承及非拥有指针；原库智能指针规则不转译为其他智能指针规则。

### RAII 与异常清理

- **成对清理与不可恢复异常**：[Guidelines/Coding.md:181–192](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L181-L192)（删去专属片段）。同时保留 RAII 的使用场景及不可恢复崩溃时的原文例外。

### C++20、模板与迭代

- **现代特性与模板**：[Guidelines/Coding.md:76–76](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L76-L76)（删去专属片段）、[Guidelines/Coding.md:151–152](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L151-L152)。原文版本范围为 C++20 及以前；移除原项目已经使用 C++20 的环境断言，保留推荐特性的原句。
- **范围循环与临时对象**：[Guidelines/Coding.md:131–131](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L131-L131)、[Guidelines/Coding.md:133–133](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L133-L133)（删去专属片段）。保留原文 C++20 上下文中的偏好和警告；不把它当作后续标准的最新结论。
- **静态分派**：[Guidelines/Coding.md:135–135](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L135-L135)。仅适用于 C++；保留原文偏好及前提。

### 指针与有效值

- **指针的无效值**：[Guidelines/Coding.md:92–92](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L92-L92)（删去专属片段）。仅适用于 C++；保留原文偏好及前提。

### 原子操作

- **正确而不过量的原子操作**：[Guidelines/Coding_MultiThreading.md:15–15](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L15-L15)。仅适用于 C++；保留原文偏好及前提。

## vczh-libraries · 不分发

### Vlpp 类型、容器与所有权

- Guidelines/Coding.md：[72–75](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L72-L75)、[84–89](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L84-L89)、[93–94](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L93-L94)、[132–132](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L132-L132)、[147–148](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L147-L148)、[167–167](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L167-L167)、[200–200](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L200-L200)、[254–255](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L254-L255)。
- Guidelines/Coding.md 混合条目中移除的专属片段：[59](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L59-L59)、[61](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L61-L61)、[92](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L92-L92)、[133](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L133-L133)、[164](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L164-L164)、[174](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L174-L174)、[187](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L187-L187)。

### 正则表达式与解析器

- Guidelines/Coding.md：[98–119](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L98-L119)。
- Guidelines/Coding.md 混合条目中移除的专属片段：[11](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L11-L11)。

### 反射与注册

- Guidelines/Coding.md：[120–130](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L120-L130)、[136–140](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L136-L140)。

### 线程、任务队列与 UI 调度

- Guidelines/Coding.md 混合条目中移除的专属片段：[188](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L188-L188)。
- Guidelines/Coding_MultiThreading.md：[4–9](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L4-L9)、[13–13](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L13-L13)、[16–16](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L16-L16)、[22–58](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding_MultiThreading.md#L22-L58)。

### Workflow Script 语言与 AST

- Guidelines/Coding.md：[233–246](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L233-L246)。

### GacUI XML 资源

- Guidelines/GacUIXmlResource.md：[1–255](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIXmlResource.md#L1-L255)。
- Guidelines/GacUIMVVM.md：[29–29](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L29-L29)。

### GacUI 数据绑定

- Guidelines/GacUIMVVM.md：[4–4](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L4-L4)、[9–9](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L9-L9)、[11–25](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L11-L25)。

### GacUI 布局与 EazyLayout

- Guidelines/GacUILayout.md：[1–115](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUILayout.md#L1-L115)。
- Guidelines/GacUIEazyLayout.md：[1–221](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIEazyLayout.md#L1-L221)。

### GacUI 运行与自动化

- Guidelines/Running-GacUI.md：[1–6](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-GacUI.md#L1-L6)、[13–58](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-GacUI.md#L13-L58)、[71–82](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-GacUI.md#L71-L82)。

## toolchain · 不分发

### 目录、源文件清单与合并发布

- Guidelines/Coding.md：[55–58](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L55-L58)、[68–69](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L68-L69)、[78–80](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L78-L80)。
- Guidelines/SourceFileManagement.md：[1–39](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/SourceFileManagement.md#L1-L39)。

### 构建工具与配置

- Guidelines/Coding.md 混合条目中移除的专属片段：[76](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L76-L76)。
- Guidelines/GacUIMVVM.md：[26–28](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L26-L28)、[30–30](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/GacUIMVVM.md#L30-L30)。
- Guidelines/SourceFileManagement.md：[60–79](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/SourceFileManagement.md#L60-L79)。
- Guidelines/Building.md：[1–33](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Building.md#L1-L33)、[35–60](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Building.md#L35-L60)。

### 调试器与内存检测

- Guidelines/Coding.md：[210–215](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L210-L215)。
- Guidelines/Coding.md 混合条目中移除的专属片段：[149](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L149-L149)。
- Guidelines/Debugging.md：[1–8](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Debugging.md#L1-L8)、[10–31](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Debugging.md#L10-L31)、[33–102](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Debugging.md#L33-L102)。

### 测试启动与过滤

- Guidelines/Coding.md：[220–220](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L220-L220)。
- Guidelines/Running-UnitTest.md：[1–57](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-UnitTest.md#L1-L57)、[59–94](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-UnitTest.md#L59-L94)、[98–100](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-UnitTest.md#L98-L100)。

### CLI 交互环境

- Guidelines/Running-CLI.md：[1–49](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-CLI.md#L1-L49)、[53–54](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-CLI.md#L53-L54)。

### Computer Use 与系统自动化

- Guidelines/Running-GacUI.md：[7–12](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-GacUI.md#L7-L12)、[59–70](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-GacUI.md#L59-L70)。
- Guidelines/Running-ComputerUse.md：[1–493](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Running-ComputerUse.md#L1-L493)。

### 平台文件、宏与编译目标

- Guidelines/Coding.md：[77–77](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L77-L77)、[194–199](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L194-L199)。
- Guidelines/SourceFileManagement.md：[40–58](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/SourceFileManagement.md#L40-L58)。

### Emscripten、WebAssembly 与浏览器宿主

- Guidelines/Coding.md：[247–253](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L247-L253)、[256–267](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Coding.md#L256-L267)。
- Guidelines/Building.md：[61–73](https://github.com/vczh-libraries/Tools/blob/493f3fe00b4a48831c1cc0612184fde709bafcb2/Copilot/Guidelines/Building.md#L61-L73)。

## 重建与校验

```sh
node scripts/vczh/rebuild.mjs --source vczh/repos/Tools/Copilot
node scripts/vczh/rebuild.mjs --source vczh/repos/Tools/Copilot --check
```

脚本先核对全部固定源文件指纹，再生成两包规范、四维审计和过滤后的共享工作流。上游变化会失败，不能静默重用旧行号。执行协议的每处改动记录在插件的 upstream/manifest.json；未列出的工作流行保留。
