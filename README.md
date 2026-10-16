# dsh-svg —— 让模型"画完能看见"

DSH Host 插件。解决的问题：**模型写 SVG 时是盲写的**——没有栅格化器就看不到自己的输出，于是文字错位、`+`/`A`/`∞` 跑到符号外面、下标断裂、中文变方框，全都会直接交付。

本插件在 Harness 内部把 SVG 渲染成 PNG，并**把图片作为原生图片块返回给模型**，闭环一次工具调用就补上了。附带一个静态体检器，专门抓生成式 SVG 的典型毛病。

## 两个工具

### `svg_render`

```jsonc
{ "path": "diagram.svg", "scale": 2 }          // 渲染工作区里的 SVG，PNG 存为 diagram.png 并附上图片
{ "svg": "<svg …>", "width": 1400 }            // 渲染内联 SVG（默认不落盘）
{ "path": "a.svg", "out": "out/a.png", "save": true, "background": "white" }
```

- 后端顺序：`@resvg/resvg-js` → `@resvg/resvg-wasm` → `rsvg-convert` → `sharp`，全不可用时报错里给出**可直接执行的安装命令**。
- 渲染成功且当前模型支持图片输入时，结果里带一个原生图片块（就是让你"看一眼"）；否则 `notes` 说明原因，PNG 仍在 `savedPath`。
- PNG 会写进工作区（`save:false` 可关）。`ctx.fs` 的写操作按契约只支持文本，所以二进制写入由插件完成，并做了**工作区范围检查**（越界直接拒绝）。

### `svg_check`

```jsonc
{ "path": "diagram.svg" }                  // 只体检
{ "path": "diagram.svg", "fix": true }     // 体检 + 机械修复，输出 diagram.fixed.svg
```

抓这些（都能让图"看起来烂"）：LaTeX 语法残渣（`u_o`、`2^3`）、`baseline-shift`（resvg/librsvg 忽略，浏览器才认）、`letter-spacing`、`foreignObject`、外链字体、中文却没有 CJK 字体、属性里的 `NaN/undefined`、重复 `id`、`stroke-width<=0`、文字跑出画布/贴边、坐标不在网格上、`<text>` 过多（逐字符定位的特征）。

`fix:true` 只做**机械且可逆**的修复：`baseline-shift` → `dy`、删 `letter-spacing`、删外链 `@import`、给 `font-family` 补 CJK 回退。

## 安装

```text
plugin_manager  action: install_bundle
                target: <本目录绝对路径>
```

装完重启 DSH（或等 HMR），`svg_render` / `svg_check` 会在下一次组装提示词时出现，同时 `skill/SKILL.md` 会作为技能进入目录。

本插件除可选依赖外不依赖任何东西，`link:` 安装不需要构建步骤：

```jsonc
// optionalDependencies —— 装不上也不影响插件加载
"@resvg/resvg-js": "^2.6.2"
```

## 验证

```bash
node --test "tests/*.test.mjs"        # 8 项：参数/输出契约、渲染、附件、越界拒绝、lint/fix
node tools/demo.mjs                    # 渲染 skill/examples/opamp.svg → tools/demo.png
DSH_SVG_BACKEND=@resvg/resvg-wasm node tools/demo.mjs skill/examples/opamp.svg tools/demo-wasm.png
```

两条渲染路径都在开发机上跑通过，输出的 PNG 已人工看过（中文、下标、几何均正确）。

## 配置（环境变量）

| 变量 | 作用 |
|---|---|
| `DSH_SVG_BACKEND` | 强制指定后端，便于排查 |
| `DSH_SVG_FONT_DIRS` | 额外的字体目录（`:` 分隔） |
| `DSH_SVG_FONT_FILES` | 额外的字体文件（WASM 后端必须靠它） |
| `DSH_SVG_FONT_FAMILY` | 默认字体族（默认 `Noto Sans CJK SC`） |

安卓容器里 `/system/fonts` 会被自动搜索，因此无需额外装字体；如果只装了 `librsvg2-bin`，请一并装 `fonts-noto-cjk`，否则中文会变方框。

## 目录

```
lib/index.js      插件入口（inject: tools, fs）
lib/backends.js   四个渲染后端的解析与调用、字体探测
lib/render.js     svg_render 工具
lib/check.js      svg_check 工具
lib/lint.js       静态规则与机械修复（纯函数，可单独用）
lib/shared.js     路径解析/工作区约束/可选包解析（含 ESM 入口修正）
skill/SKILL.md    给 agent 的流程与硬规则
skill/examples/opamp.svg  正确写法示例（svg_check 0 告警）
tests/            假 Host + 契约校验 + 用例
tools/demo.mjs    渲染冒烟脚本
```

## 设计取舍

- **为什么在 Host 里渲染**：模型没有浏览器，手机容器也没有 `rsvg-convert`；把渲染放进 Harness，才可能"画完立刻看见"。
- **为什么图片走附件服务**：与内置 `read_image` 同一条路径（`ctx.attachments.saveImage` + 原生图片块），受部署的图片配额约束；图片过大时自动降到适合查看的宽度再附一次。
- **为什么自己写 PNG**：`ctx.fs` 的变更契约明确只支持文本（二进制写入上游标记为 deferred），PNG 必须由插件写盘；因此越界检查由插件承担，写之前用 `ctx.fs.resolve/contains` 授权、再用 `path.resolve` 二次确认在工作区内。
