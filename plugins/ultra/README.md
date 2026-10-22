# Ultra

安装并启用插件后，在主会话输入 `/ultra` 开启协作，或发送 `/ultra 帮我完成……` 直接开始任务。`/ultra off` 关闭。开关只影响当前会话，恢复会话后保留。当前轮次执行中时，沿用 Coda 的斜杠命令规则：空闲后再发送。

主 Agent 按 `instructions.md` 主动拆分任务，通过 Coda 子会话协作、接收结果并验证。插件加载本身不开启 Ultra。这个插件需要支持 `contributes.sessionModes` 的 Coda 宿主。

宿主参考实现位于 [xtlys/coda 的 feature/ultra-mode 分支](https://github.com/xtlys/coda/tree/feature/ultra-mode)（私有独立副本）。现行上游宿主尚不识别此模式声明。

## 子 Agent 配置

编辑插件目录中的 `subagents.json`。默认 `{}`，继承主 Agent 本轮实际使用的程序、模型、推理等级和模型选项；配置在下一轮读取，已有子会话续跑保持原配置。

指定已安装的自定义 Codex：

```json
{"agent": "codex-custom"}
```

指定已安装的 DSH：

```json
{"agent": "dsh"}
```

也可指定 `model`、`effort`、`options`，值必须来自目标 Agent 的配置目录；省略或 `null` 表示未指定。同程序、同模型时，未指定的配置继承父轮次；换程序或模型时使用目标自己的默认值。审批模式始终沿用 Coda 的委派规则，配置文件不能覆盖。显式 `spawn` 参数优先于文件中的默认值。

从 Git 安装时，在自己的仓库修改此文件、提交后更新插件；宿主内置副本则随自己的 Coda 构建发布。直接修改运行时插件目录可能被更新覆盖。

当前模式默认配置作用于本机、当前项目的 Coda `spawn`。派到其他项目或机器时仍需显式选择 Agent，沿用原有确认与委派流程。主动委派由提示词引导，不保证模型一定拆分任务，也不从宿主隐藏厂商原生工具。
