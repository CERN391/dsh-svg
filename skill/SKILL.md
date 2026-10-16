---
name: svg-render
description: Use whenever you draw or edit an SVG diagram, schematic, chart or illustration (画图、示意图、电路图、流程图、架构图、SVG 配图). The tools rasterize the SVG inside the Harness and return the picture to you, and lint the document for the mistakes that make generated diagrams look broken. Never ship an SVG you have not rendered and looked at.
---

# 画图（SVG）——必须先渲染再看

本技能配两个工具：

| 工具 | 用途 |
|---|---|
| `svg_render` | 把 SVG 栅格化成 PNG，**并把图片直接返回给你**（原生图片块），同时把 PNG 写进工作区 |
| `svg_check` | 静态体检：LaTeX 残渣、`baseline-shift`、逐字符 `<text>`、外链字体、中文无 CJK 字体、文字越界、NaN、重复 id；`fix:true` 可机械修复 |

**铁律：没渲染、没亲眼看过的 SVG，不算画完。**

## 标准流程（至少两轮）

1. 写 SVG（先用 `svg_render` 的 `svg:` 参数试渲染，不必先落盘）。
2. `svg_check`（有 `fix:true` 时它会顺手修掉 `baseline-shift`、`letter-spacing`、外链字体、缺 CJK 字体）。
3. `svg_render` → **看返回的图片**，逐项检查：
   - 文字有没有互相压住 / 压线 / 跑出画布 / 贴边被裁；
   - `+ − A ∞` 这类符号是否还在容器（运放三角形）里；
   - 导线端点是否落在节点上，有没有悬空线头；
   - 中文是不是方框（tofu）；
   - 同类符号朝向是否一致（别出现镜像运放）。
4. 按看到的问题改坐标 → 再 `svg_render` 一次确认。**最后一轮专门查边距与裁切。**
5. 交付时给出 PNG 路径（`savedPath`），必要时用 `present`。

## 可移植子集（写 SVG 时照做）

1. **一行文字 = 一个 `<text>`**；禁止逐字符 `<text x=…>`，禁止 `letter-spacing`。
2. 下标用 `<tspan dy="7" font-size="70%">`；**不要** `baseline-shift`（resvg/librsvg 直接忽略，浏览器才认——两端效果不一致）。
3. 不写 `u_o`、`2^3` 这类 LaTeX 语法；没有 KaTeX/MathJax 时下划线会原样漏出来。
4. 不用 `foreignObject`；不引外链字体（`@import`/CDN 离线必失败，字体一变全部标签错位）。
5. `font-family` 显式写中文字体 + 通用回退，例如
   `font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"`。
6. 坐标全部落在 5 或 10px 网格；导线用统一的生成器函数，不要手打坐标。
7. 符号（运放、电阻、接地、开关、箭头）做成函数，`+ − A ∞` 的位置由几何算出来。
8. 画布四周留 ≥24px 边距；背景要么显式画 `<rect fill="#fff">`，要么渲染时传 `background:"white"`。
9. 同一张图里同类符号朝向一致。

## 症状 → 修法

| 症状 | 原因 | 修法 |
|---|---|---|
| `u ₀`、`U OM`：变量和下标隔很远 | 逐 token 定位 / 字体度量不符 | 合并成一个 `<text>` + `<tspan dy>` |
| `_⇒`、`_ u _1`：出现下划线 | LaTeX 语法被当纯文本 | 删掉 `_`/`^`，写真实下标 |
| 下标在浏览器正常、导出图里不下沉 | `baseline-shift` 被忽略 | `svg_check fix:true` 或手改 `dy` |
| 中文变方框 | 没有 CJK 字体 | 补 `font-family`；渲染端装 `fonts-noto-cjk` 或指 `DSH_SVG_FONT_DIRS` |
| 标签整体错位、挤在一起 | 字体回退（外链字体没加载） | 去掉外链字体，`svg_check` 会报 |
| `+`/`A`/`∞` 跑到符号外面 | 装饰文字用了写死的相对坐标 | 由符号函数按几何算位置 |
| 文字贴边被裁 | 没留边距 | 四周 ≥24px，`svg_check` 会提示 |

## 后端与排查

`svg_render` 依次尝试：`@resvg/resvg-js`（推荐，预编译二进制，安卓 arm64 与 Windows 都有）→ `@resvg/resvg-wasm`（无需本机二进制，需要字体文件）→ `rsvg-convert`（`apt-get install librsvg2-bin fonts-noto-cjk`）→ `sharp`。

- 一个都不可用时，报错里会给出可直接执行的安装命令。
- 强制指定后端调试：`DSH_SVG_BACKEND=@resvg/resvg-wasm`。
- 字体搜索路径：`DSH_SVG_FONT_DIRS`（目录列表）；字体文件：`DSH_SVG_FONT_FILES`；默认族：`DSH_SVG_FONT_FAMILY`。安卓上 `/system/fonts` 会被自动搜索。
- 图片没有作为图片块返回时（模型不支持图片输入、或没有附件服务），结果里的 `notes` 会说明原因，PNG 仍在 `savedPath`，可用 `read_image` 打开。

参考示例：`skill/examples/opamp.svg`（运放电路，正确写法，0 告警）。
