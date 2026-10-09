# 原理图网络工具箱（sch-net-tools）

License: Apache-2.0 ｜ 适用于嘉立创EDA专业版 V3.2+ ｜ 当前版本 v1.0.0

立创EDA专业版扩展：**原理图网络标签批量改名工具**。单个面板内完成查找预览与批量替换，支持正则表达式与捕获组，覆盖电源/地标志、网络端口（跨图页）与导线网络名。全部改名逻辑已在真实编辑器（V3.2.186）端到端验证。

![面板截图](https://raw.githubusercontent.com/SevenBit250/lcedapro_extension_net_modify/main/docs/screenshot-panel.png)

## 功能

- **查找**：列出全部匹配的网络名（按 类型 + `旧名 → 新名` 聚合、计数），不做任何修改
- **替换**：批量执行修改，逐条显示结果（✔ 成功数 / ✘ 失败原因）
- **正则表达式**（复选框）：勾选后按正则匹配，替换文本支持 `$1`、`$2`… 捕获组引用
- **区分大小写**（复选框）
- 替换后为空名的条目自动跳过；普通文本模式下 `$` 按字面处理，不会误解释
- 改名**不自动保存工程**——执行后自行检查画布，Ctrl+S 手动保存

### 覆盖对象与实测结论

| 网络对象 | 范围 | 文档模型 | 实测改名路径 |
|---|---|---|---|
| 电源/地标志（VCC/GND 符号） | 跨图页 | 元件图元，网络名在子属性「Name」 | `sch_PrimitiveAttribute.modify(子属性ID, {value})`，并同步「Global Net Name」 |
| 网络端口（IN/OUT/BI） | 跨图页 | 同上 | 同上 |
| 导线网络名 | 当前图页 | 图元自身 `net` 属性 | `sch_PrimitiveWire.modify(id, {net})` |
| 网络标签属性图元（key=NET） | 当前图页 | ATTRIBUTE 图元（EDA v4 模型） | 预留，v3 未启用（`createNetLabel` 为 v4 专属） |

改名后画布效果（VCC → VCC_TEST，2 个电源标志 + 1 条导线）：

![画布效果](https://raw.githubusercontent.com/SevenBit250/lcedapro_extension_net_modify/main/docs/screenshot-canvas.png)

## 安装

### 方式一：下载安装包

从 GitHub 仓库 [release/ 目录](https://github.com/SevenBit250/lcedapro_extension_net_modify/tree/main/release)（或 [Releases 页面](https://github.com/SevenBit250/lcedapro_extension_net_modify/releases)）下载 `sch-net-tools_v1.0.0.eext`，然后：

1. 打开嘉立创EDA专业版（V2：设置 → 扩展 → 扩展管理器；V3/V4：高级 → 扩展管理器）
2. 点击「导入」，选择 `.eext` 文件
3. **扩展详情 → 配置 → 勾选「显示在顶部菜单」**（默认不显示，必做）
4. 打开工程和原理图，顶部菜单出现「网络工具」

### 方式二：从源码构建

```bash
git clone https://github.com/SevenBit250/lcedapro_extension_net_modify.git
cd lcedapro_extension_net_modify
npm install        # Node.js ≥ 20.5
npm run build      # 产物 → build/dist/*.eext
```

## 使用示例

| 场景 | 查找 | 替换 | 说明 |
|---|---|---|---|
| 网络加前缀 | `^` | `MCU_` | 正则锚点，全部网络加前缀 |
| 捕获组引用 | `^(VCC)$` | `$1_5V` | VCC → VCC_5V |
| 批量后缀清理 | `_old$` | （留空） | 删除 `_old` 后缀 |
| 普通替换 | `VCC` | `VCC_3V3` | 包含即替换，`$` 按字面处理 |

先点「查找」确认匹配列表无误，再点「替换」执行。

## 技术要点（给扩展开发者的实测笔记）

基于官方扩展 API（[文档](https://prodocs.lceda.cn/cn/api/guide/)）开发，以下为实测踩坑记录（编辑器 V3.2.186 / API 运行时 0.3.18）：

- 网络标签/电源标志/网络端口**不是导线属性**：netflag/netport 的网络名存在元件的**子属性**「Name」中（netflag 另有「Global Net Name」需同步修改）
- `sch_PrimitiveComponent.modify({name})` 对 netflag/netport **直接抛错**（"仅当器件类型为元件时允许修改"），只能走子属性路径
- `sch_PrimitiveAttribute.getAll()` 无参调用只返回图页级自由属性图元；取元件子属性必须 `getAll(父图元ID)`
- `sch_PrimitiveWire.modify(id, {net})` 可直接改导线网络名；`sch_PrimitiveWire.create` 只接受扁平坐标数组
- `createNetLabel` 是 EDA v4 专属 API（v3 调用会挂起）；v3 图页的 `Attribute.getAll()` 通常为空
- **扩展沙箱无 `window`/`localStorage`/`document`**（`typeof window === 'undefined'`），无法向主窗口注入桥接对象；`activationEvents` 官方标注 feature in working 不生效
- 本扩展的面板为**自包含内联框架**（`SYS_IFrame` + 同源 iframe），经主窗口的 `_EXTAPI_ROOT_` 全局（由 [EasyEDA API Gateway](https://github.com/easyeda) 类桥接扩展注入）调用编辑器 API；该全局缺失时面板显示降级提示
- 安装后菜单不显示：扩展索引的 `isShowAtHeaderMenu` 默认 false，需在「配置」中勾选「显示在顶部菜单」

## 目录结构

```
├── extension.json        # 扩展清单（菜单、入口、元信息）
├── src/
│   ├── index.ts          # 菜单入口（打开面板 / 列出网络标签 / 关于）
│   ├── netlabel.ts       # 核心：采集、名称变换、批量应用
│   └── ui.ts             # 原生对话框封装（Promise 化）
├── iframe/
│   └── net-tools.html    # 批量改名面板（自包含，查找/替换双按钮）
├── build/ config/        # SDK 构建脚本（esbuild + 打包 .eext）
├── docs/                 # 截图
├── release/              # 预构建 .eext（可直接下载导入）
└── e2e.mjs               # CDP 端到端验证脚本（开发辅助，依赖本机环境）
```

## 已知限制

- 电源/地标志与网络端口支持跨图页；导线网络名限当前图页（API 范围）
- v4 自由网络标签路径保留但未在 v3 验证
- 按网络名整体匹配替换，天然避免"同一网络部分改名导致网络分裂"

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
