# 导出 PCB 为 SVG

将当前 PCB 文档一键导出为多个按层切分的 SVG 文件，并自动打包为 ZIP，方便测试、归档、二次编辑。

本扩展不再直接遍历 PCB 图元，而是基于 **Gerber / Excellon** 制造数据管线：从 EasyEDA 获取 Gerber ZIP，解压后用 `@tracespace` v5 解析、铺铜并渲染为 SVG，从而获得与制造输出一致的层图像。

![](images/top.jpg)

## 功能特性

- **基于 Gerber/Excellon**：直接消费 `eda.pcb_ManufactureData.getGerberFile()` 返回的 Gerber ZIP，覆盖顶层/底层铜、丝印、阻焊、钢网、内层、边框、机械层、钻孔等所有制造层
- **按层拆分**：每个 Gerber / Excellon 文件单独渲染为一个 SVG 文件
- **高保真渲染**：使用 `@tracespace/parser`、`@tracespace/plotter`、`@tracespace/renderer`（v5.0.0-alpha.0）完成解析、铺铜与 SVG 生成
- **大板友好**：`createParser` 采用分块喂入（chunked feeding）方式解析 Gerber 文本，避免大文件一次性 parse 导致栈溢出
- **ZIP 打包**：全部 SVG 文件统一压缩到一个 ZIP，方便分发
- **一键导出**：支持导出当前板子或工程下所有板子
- **自定义导出**：支持勾选层、设置镜像、合并/独立导出
- **网络标注**：铜层 SVG 节点自动标注 `net` 属性

## 文件命名规则

每个 SVG 文件沿用原始 Gerber 文件名，仅追加 `.svg` 后缀：

```
Gerber_TopLayer.GTL.svg
Gerber_BottomLayer.GBL.svg
Gerber_TopSilkscreen.GTO.svg
Gerber_BoardOutline.GKO.svg
```

ZIP 包名：

```
SVG_<板子名称>_<PCB文件名>.zip
```

例如 `SVG_MyBoard_PCB1_V1.0.zip`。

合并导出时，ZIP 内仅含一个 `Merged.svg`；独立导出时，ZIP 内为各层 SVG。

## 安装与使用

1. 打开 嘉立创EDA 专业版
2. 顶部菜单 → 扩展 → 本地扩展 → 选择 `build/dist/export-pcb-svg_v1.0.0.eext` 安装
3. 安装后重启客户端
4. 在 PCB 编辑器中点击菜单 **导出 PCB 为 SVG** → **导出当前板子为 SVG** 或 **导出所有板子为 SVG**
5. 浏览器会触发 ZIP 下载

## 菜单项

- `PCB` 编辑器菜单 → **Export PCB to SVG**
  - **Export Current Board to SVG...** — 导出当前打开的板子（全部层，不镜像，独立 SVG）
  - **Export Current Board to SVG (Custom)...** — 自定义导出：勾选层、设置镜像、合并/独立导出
  - **Export All Boards to SVG...** — 导出工程下所有板子

## 开发

```bash
# 安装依赖（会自动应用 patch-package 补丁）
npm install

# 开发模式（增量构建 + 监听 + 自动推送）
npm run debug

# 生产构建 + 打包扩展包
npm run build

# 代码风格检查
npm run lint
```

打包后的产物在 `build/dist/export-pcb-svg_v1.0.0.eext`。

### 项目结构

```
src/
├─ index.ts            # 入口：菜单处理、导出流程 orchestration、ZIP 保存
├─ gerber-source.ts    # 从 EDA 获取 Gerber ZIP 并解压、分类层角色
├─ gerber-render.ts    # 用 tracespace v5 解析/铺铜/渲染 Gerber → SVG
├─ pour-net.ts         # 收集画布铺铜网络，给铜层 SVG 节点标注 net 属性
└─ zip-builder.ts      # 基于 JSZip 的浏览器端 ZIP 打包

locales/               # 多语言文案（i18n）
config/                # esbuild 构建配置
patches/               # patch-package 补丁（@tracespace/plotter）
test/                  # 离线 smoke 测试与 EDA 网桥验证脚本
extension.json         # 扩展元数据 + 菜单注册
```

## SVG 与 Gerber 坐标的对应关系

Gerber 数据坐标：Y 轴向上为正。
SVG 屏幕坐标：Y 轴向下为正。

渲染由 `@tracespace/renderer` 内部完成坐标转换，输出 SVG 的 `viewBox` 与路径坐标直接对应 Gerber 逻辑位置，视觉上与 PCB 画布保持一致。

## 实现要点

- **数据来源**：`eda.pcb_ManufactureData.getGerberFile()` 返回完整的 Gerber ZIP
- **解压与分类**：`src/gerber-source.ts` 用 `JSZip` 解压，并按 JLCPCB 风格扩展名（`GTL`、`GBL`、`GTO`、`GKO`、`DRL` 等）识别层角色
- **解析策略**：`src/gerber-render.ts` 中 `parseGerberText` 将 Gerber 文本按 500 行分块喂给 `createParser()`，避免一次性解析大文件爆栈
- **渲染链**：`parse` → `plot` → `render`，最终通过自定义的 HAST → XML 序列化生成带 XML 声明的 SVG 字符串
- **颜色**：每个 SVG 使用 EDA 层表中对应层的颜色作为 `currentColor`
- **网络标注**：`src/pour-net.ts` 通过 `getPrimitiveAtPoint` 命中焊盘/走线/过孔，并对铺铜区域用 complexPolygon 包围盒 + 自校准偏移匹配网络
- **自定义导出**：`src/index.ts` 通过 `sys_Dialog.showSelectDialog` 让用户选层、选镜像层，`showConfirmationMessage` 选择合并/独立模式
- **合并导出**：把各层 SVG 子节点按层分组，统一到一个 `viewBox` 中，每层一个带 `style="color:..."` 的 `<g>`
- **镜像**：对需要镜像的层绕其 SVG 中心线做水平翻转（`translate(2*cx, 0) scale(-1, 1)`）
- **打包**：`JSZip.generateAsync({ type: 'blob', compression: 'DEFLATE' })`
- **保存**：`eda.sys_FileSystem.saveFile(blob, fileName)`

## 本地补丁

项目使用 `patch-package` 对 `@tracespace/plotter` 5.0.0-alpha.0 打了两个本地补丁（见 `patches/@tracespace+plotter+5.0.0-alpha.0.patch`）：

- 修复 rounded-rect macro 中 vector line 的偏移计算
- 修复 rectangular tool path 的 `Math.atan2` 参数错误

安装依赖时 `postinstall` 脚本会自动应用这些补丁。

## 测试

```bash
# 离线 smoke 测试：解析 test/test.zip 并输出各层 SVG 路径数量统计
node test/smoke.mjs

# 在 EDA 网桥内触发 exportCurrentBoardToSvg，拉回流并校验 ZIP 内容
BRIDGE_PORT=49620 node test/verify.cjs
```

- `test/smoke.mjs`：不依赖 EDA 运行时，验证 tracespace v5 管线能正确解析测试 Gerber 并生成有效 SVG
- `test/verify.cjs`：通过 EasyEDA 扩展 WebSocket 网桥执行扩展，拦截 `saveFile`，校验 ZIP 中至少包含 5 个 SVG，且每个 SVG 都以 `<?xml` 开头

## 已知限制

- 最终效果受 EDA 生成 Gerber ZIP 的内容与精度影响；PCB 画布中某些实时渲染效果（如半透明覆铜、3D 视图）不会出现在制造数据中
- 钻孔层依赖 Excellon 格式；若 EDA 输出非标准钻孔文件，可能无法被识别
- `@tracespace/plotter` 目前通过本地补丁修正两处渲染问题，上游修复后应移除补丁

## 开源许可

基于 [easyeda/pro-api-sdk](https://github.com/easyeda/pro-api-sdk)，遵循 Apache-2.0 许可协议。
