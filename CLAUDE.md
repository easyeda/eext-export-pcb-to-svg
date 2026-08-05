# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 对话语言

**所有用户可见的回复默认使用简体中文**（包含代码注释、toast 提示、commit message、文档说明等）。

例外：
- 技术专有名词（API 名称、类名、字段名、库名、错误信息原文）保持英文不翻译。
- 工具输出（grep/lint/stack trace）原样保留英文。
- 用户主动切到英文时跟随切换。

## 常见命令

```bash
# 安装依赖（会触发 postinstall 用 patch-package 打本地补丁）
npm install

# 开发构建（增量 + watch + 自动推送）
npm run debug

# 生产构建并打包为 .eext 扩展包
npm run build

# 代码风格检查 / 自动修复
npm run lint
npm run fix
```

## 测试

```bash
# 离线 smoke 测试：解析 test/test.zip，统计各层 SVG 路径数
node test/smoke.mjs

# 端到端验证：通过 EasyEDA 扩展 WebSocket 桥接触发 exportCurrentBoardToSvg，
# 拦截 saveFile 拉回流并校验 ZIP 内容。
# 需要先在 EDA 中加载扩展并启动 easyeda-api bridge。
BRIDGE_PORT=49620 node test/verify.cjs
```

`test/verify.cjs` 默认 30s 超时；若 `getGerberFile()` 较慢，需要把 bridge 的超时调大（如 120s）。

## 项目架构

这是一个**嘉立创EDA / EasyEDA 专业版扩展**，把当前 PCB 导出为按层拆分的 SVG ZIP。

数据管线：

```
用户点击菜单
  └─ src/index.ts
       ├─ 检查当前为 PCB 文档
       ├─ 取板子名 / PCB 文件名
       ├─ src/gerber-source.ts    调用 eda.pcb_ManufactureData.getGerberFile()
       │                              解压 Gerber ZIP 并按 JLCPCB 扩展名分类
       ─ src/gerber-render.ts    用 @tracespace v5 parse → plot → render
       │                              再自定义 HAST → XML 序列化得到 SVG
       ├─ src/pour-net.ts         从画布收集铺铜网络，自校准偏移后给铜层 SVG 节点加 net 属性
       └─ src/zip-builder.ts      用 JSZip 打包，交给 eda.sys_FileSystem.saveFile
```

关键模块：

- `src/index.ts`
  - 扩展入口，注册 `exportCurrentBoardToSvg` / `exportAllBoardsToSvg`。
  - ZIP 文件名格式：`SVG_<boardName>_<pcbName>.zip`。
  - 构建后输出为 IIFE，全局变量名 `edaEsbuildExportName`。

- `src/gerber-source.ts`
  - 调用 `eda.pcb_ManufactureData.getGerberFile()` 获取制造数据 ZIP。
  - 用 `JSZip` 解压，按文件扩展名（`GTL/GBL/GTO/GBO/GTS/GBS/GTP/GBP/GKO/GML/DRL` 等）识别层角色。
  - `.TXT` 文件会通过内容嗅探判断是 Gerber 还是 Excellon。

- `src/gerber-render.ts`
  - 用 `@tracespace/parser` + `@tracespace/plotter` + `@tracespace/renderer`（v5.0.0-alpha.0）解析并渲染。
  - `parseGerberText` 把 Gerber 文本按 500 行分块喂给 parser，避免大文件一次性 parse 爆栈。
  - 将 tracespace 的 HAST 树手动序列化为 XML，输出带 `<?xml>` 声明的 SVG 字符串。
  - 给铜层（top/bottom/inner）的 SVG 节点附加 `net` 属性；非铜层不加。

- `src/pour-net.ts`
  - 通过 `eda.pcb_PrimitivePour.getAll()` 收集铺铜网络表。
  - 通过 `eda.pcb_Document.getPrimitiveAtPoint` 命中焊盘/走线/过孔的 net。
  - 铺铜区域用 complexPolygon 包围盒 + 偏移量做包含测试。
  - 偏移量通过 `gerber-render.ts` 中的 `derivePourOffset` 自校准：对"铺铜中心"与"SVG 填充区域中心"做聚类，正确偏移跨铺铜形成主簇。
  - 不再依赖 `getPrimitivesInRegion`（在复杂铺铜板子上会触发 EDA "单多边形验证不通过"）。

- `src/zip-builder.ts`
  - 浏览器端用 JSZip 把多个 SVG 文本打包为 Blob，最终调用 `eda.sys_FileSystem.saveFile`。

## 坐标系约定

- PCB 画布 / EDA 图元：单位 mil，Y 轴向上。
- Gerber / image-tree / SVG 的 `viewBox`：单位 mm，Y 轴向上。
- 最终渲染出的 SVG 由 tracespace 内部翻转 Y 轴，因此屏幕坐标 Y 向下。
- `MM2MIL = 1000 / 25.4` 用于 mm 与 mil 互转。

## 本地补丁

安装依赖时 `postinstall` 会自动应用 `patches/@tracespace+plotter+5.0.0-alpha.0.patch`，修复 `@tracespace/plotter` 的 rounded-rect macro 与 rectangular tool path 问题。
