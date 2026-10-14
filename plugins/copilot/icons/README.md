# GitHub Copilot 图标

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

`copilot.svg` 取自 GitHub 官方 [Primer Octicons](https://github.com/primer/octicons/blob/main/icons/copilot-24.svg)
的 `copilot-24.svg`，按 [MIT 许可](LICENSE) 使用。保留路径与 `viewBox`，只将宽高从 24 放大到 256，
以符合 Coda 的图标画布要求。单色，清单的 `template: true` 让它随文字颜色着色。

提取日期：2026-10-14。SVG 是可审阅的源文件，PDF 是 CairoSVG 转换的矢量资源。重新生成（开发工具，不是运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
cairosvg.svg2pdf(url='copilot.svg', write_to='copilot.pdf')
PY
```
